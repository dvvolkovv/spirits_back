// src/smm/scenarios/scenarios.controller.ts
import {
  Body, Controller, Delete, Get, NotFoundException, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { ScenarioService } from '../producer/scenario.service';
import { ApprovalService } from '../producer/approval.service';
import { PgService } from '../../common/services/pg.service';

@Controller('smm/scenarios')
@UseGuards(JwtGuard, AdminGuard)
export class ScenariosController {
  constructor(
    private readonly scenarios: ScenarioService,
    private readonly approval: ApprovalService,
    private readonly pg: PgService,
  ) {}

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const s = await this.scenarios.getById(id);
    if (!s) throw new NotFoundException(`scenario ${id} not found`);
    // Attach latest rendered video id (if any) — frontend uses this to embed
    // the player on page reload, since ScenarioCard's local state is lost.
    const v = await this.pg.query(
      `SELECT id FROM smm_video
        WHERE scenario_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    return { ...s, videoId: v.rows[0]?.id ?? null };
  }

  @Post(':id/approve')
  async approveOne(@Req() req: any, @Param('id') id: string) {
    const result = await this.approval.approveScenarios({
      userId: req.user.phone,
      scenarioIds: [id],
    });
    // Attribute render cost to the ai-сообщение that introduced this scenario.
    // ChatInterface fetches custom_chat_history on reload — without this update
    // (a) "X токенов" suffix would only reflect Claude API cost and (b) the
    // SmmVideoPlayer wouldn't restore until the user opens the ScenarioCard.
    for (const a of result.approved) {
      try {
        const vRes = await this.pg.query(
          `SELECT tokens_charged FROM smm_video WHERE id = $1`,
          [a.videoId],
        );
        const charge = Number(vRes.rows[0]?.tokens_charged ?? 0);
        await this.pg.query(
          `UPDATE custom_chat_history
              SET tokens_used = COALESCE(tokens_used, 0) + $1,
                  content     = content || E'\n\n{{smm_video:id=' || $2::text || '}}'
            WHERE id = (
              SELECT id FROM custom_chat_history
               WHERE sender_type = 'ai'
                 AND position('smm_scenario:id=' || $3::text in content) > 0
                 AND position('smm_video:id=' || $2::text in content) = 0
               ORDER BY created_at DESC LIMIT 1
            )`,
          [charge, a.videoId, a.scenarioId],
        );
      } catch { /* ignore — UI still works through ScenarioCard.videoId */ }
    }
    return result;
  }

  @Post(':id/regenerate')
  async regen(@Req() req: any, @Param('id') id: string, @Body() body: { feedback: string }) {
    const r = await this.scenarios.regenerate(id, body.feedback || '');
    // Deduct Claude cost from the user's Linkeon balance and attribute it to
    // the ai-сообщение that contains this scenario, so "X токенов" updates.
    const tokens = Math.ceil(r.costUsd * 100_000);
    if (tokens > 0) {
      try {
        await this.pg.query(
          `UPDATE ai_profiles_consolidated
              SET tokens = GREATEST(0, tokens - $1), updated_at = now()
            WHERE user_id = $2`,
          [tokens, req.user.phone],
        );
        await this.pg.query(
          `UPDATE custom_chat_history
              SET tokens_used = COALESCE(tokens_used, 0) + $1
            WHERE id = (
              SELECT id FROM custom_chat_history
               WHERE sender_type = 'ai'
                 AND position('smm_scenario:id=' || $2::text in content) > 0
               ORDER BY created_at DESC LIMIT 1
            )`,
          [tokens, id],
        );
      } catch { /* ignore */ }
    }
    return { ok: true };
  }

  @Delete(':id')
  async reject(@Param('id') id: string) {
    await this.approval.rejectScenario(id);
    return { ok: true };
  }
}
