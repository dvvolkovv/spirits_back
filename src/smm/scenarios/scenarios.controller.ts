// src/smm/scenarios/scenarios.controller.ts
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get,
  NotFoundException, Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { ScenarioService } from '../producer/scenario.service';
import { ApprovalService } from '../producer/approval.service';
import { CreatorCampaignService } from '../producer/creator-campaign.service';
import { PgService } from '../../common/services/pg.service';

@Controller('smm/scenarios')
@UseGuards(JwtGuard)
export class ScenariosController {
  constructor(
    private readonly scenarios: ScenarioService,
    private readonly approval: ApprovalService,
    private readonly creators: CreatorCampaignService,
    private readonly pg: PgService,
  ) {}

  /**
   * Ensure the JWT user owns the campaign that this scenario belongs to.
   * Admins can read/modify any scenario; non-admins can only touch their own.
   * Throws ForbiddenException on mismatch, NotFoundException if scenario missing.
   */
  private async assertCanAccessScenario(scenarioId: string, req: any): Promise<void> {
    const r = await this.pg.query(
      `SELECT c.user_id
         FROM smm_scenario s
         JOIN smm_campaign c ON c.id = s.campaign_id
        WHERE s.id = $1`,
      [scenarioId],
    );
    if (r.rows.length === 0) throw new NotFoundException(`scenario ${scenarioId} not found`);
    if (req.user?.isAdmin) return;
    if (r.rows[0].user_id !== req.user?.userId) {
      throw new ForbiddenException('not your scenario');
    }
  }

  @Get(':id')
  async getOne(@Req() req: any, @Param('id') id: string) {
    await this.assertCanAccessScenario(id, req);
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
    // Campaign-level flags for the branding UI. is_linkeon_official decides
    // whether to surface the "Brand" button at all; creatorSettings preload
    // logo/slogan/publishCaption for non-Linkeon campaigns.
    const cRes = await this.pg.query(
      `SELECT is_linkeon_official FROM smm_campaign WHERE id = $1`,
      [s.campaignId],
    );
    const isLinkeonOfficial = !!cRes.rows[0]?.is_linkeon_official;
    const creatorSettings = isLinkeonOfficial
      ? null
      : await this.creators.getByCampaign(s.campaignId);
    return {
      ...s,
      videoId: v.rows[0]?.id ?? null,
      isLinkeonOfficial,
      creatorSettings,
    };
  }

  @Post(':id/approve')
  async approveOne(@Req() req: any, @Param('id') id: string) {
    await this.assertCanAccessScenario(id, req);
    const result = await this.approval.approveScenarios({
      userId: req.user.userId,
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
    await this.assertCanAccessScenario(id, req);
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
          [tokens, req.user.userId],
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

  /**
   * Manual edit of a scenario from the UI (ScenarioEditModal). No Claude call,
   * no token charge — just direct field updates. After approve already produced
   * a video, edits won't auto-rerender; the user clicks "Сделать заново" to
   * regenerate the mp4 with the new dialog/b-roll.
   */
  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: {
      title?: string;
      mood?: string;
      assistant_role?: string;
      dialog?: Array<{ speaker: 'hero' | 'assistant'; text: string; tStart: number; tEnd: number }>;
      broll_prompts?: Array<{ atSec: number; type: 'ai_image' | 'stock_video'; prompt: string }>;
      premiumGenre?: 'surreal' | 'pov' | 'cinematic' | null;
      scenes?: Array<{
        type: 'kling' | 'imagen';
        keyframe_prompt?: string;
        motion_prompt?: string;
        image_prompt?: string;
        duration?: number;
      }> | null;
    },
  ) {
    if (body.premiumGenre !== undefined && body.premiumGenre !== null) {
      if (!['surreal', 'pov', 'cinematic'].includes(body.premiumGenre)) {
        throw new BadRequestException('premiumGenre must be surreal|pov|cinematic|null');
      }
    }
    await this.assertCanAccessScenario(id, req);
    const existing = await this.pg.query(`SELECT id FROM smm_scenario WHERE id = $1`, [id]);
    if (existing.rows.length === 0) throw new NotFoundException(`scenario ${id} not found`);

    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (typeof body.title === 'string') {
      if (!body.title.trim()) throw new BadRequestException('title cannot be empty');
      sets.push(`title = $${i++}`); vals.push(body.title.trim());
    }
    if (typeof body.mood === 'string') {
      const allowed = ['dramatic', 'inspiring', 'calm', 'uplifting', 'tense', 'neutral'];
      if (!allowed.includes(body.mood)) throw new BadRequestException(`mood must be one of ${allowed.join(', ')}`);
      sets.push(`mood = $${i++}`); vals.push(body.mood);
    }
    if (typeof body.assistant_role === 'string' && body.assistant_role.trim()) {
      sets.push(`assistant_role = $${i++}`); vals.push(body.assistant_role.trim());
    }
    if (Array.isArray(body.dialog)) {
      if (body.dialog.length === 0) throw new BadRequestException('dialog must have at least 1 turn');
      for (const t of body.dialog) {
        if (!['hero', 'assistant'].includes(t.speaker)) throw new BadRequestException(`speaker must be 'hero' or 'assistant'`);
        if (typeof t.text !== 'string' || !t.text.trim()) throw new BadRequestException('dialog text required');
        if (typeof t.tStart !== 'number' || typeof t.tEnd !== 'number' || t.tEnd <= t.tStart) {
          throw new BadRequestException('dialog tStart/tEnd invalid');
        }
      }
      sets.push(`dialog = $${i++}::jsonb`); vals.push(JSON.stringify(body.dialog));
    }
    if (Array.isArray(body.broll_prompts)) {
      for (const b of body.broll_prompts) {
        if (typeof b.atSec !== 'number') throw new BadRequestException('broll atSec must be a number');
        if (!['ai_image', 'stock_video'].includes(b.type)) throw new BadRequestException(`broll type must be 'ai_image' or 'stock_video'`);
        if (typeof b.prompt !== 'string' || !b.prompt.trim()) throw new BadRequestException('broll prompt required');
      }
      sets.push(`broll_prompts = $${i++}::jsonb`); vals.push(JSON.stringify(body.broll_prompts));
    }
    if (body.premiumGenre !== undefined) {
      // null is allowed (clears premium mode); non-null values already validated above
      sets.push(`premium_genre = $${i++}`); vals.push(body.premiumGenre ?? null);
    }
    if (body.scenes !== undefined) {
      if (body.scenes !== null) {
        if (!Array.isArray(body.scenes) || body.scenes.length === 0) {
          throw new BadRequestException('scenes must be a non-empty array or null');
        }
        let klingCount = 0;
        let isFirstKling = true;
        for (const s of body.scenes) {
          if (!['kling', 'imagen'].includes(s.type)) {
            throw new BadRequestException(`scene type must be 'kling' or 'imagen'`);
          }
          if (s.type === 'kling') {
            // keyframe_prompt обязателен только для первой kling-сцены — остальные
            // получают keyframe через extract-last-frame chain в worker'е.
            if (isFirstKling && (typeof s.keyframe_prompt !== 'string' || !s.keyframe_prompt.trim())) {
              throw new BadRequestException('first kling scene requires keyframe_prompt');
            }
            if (typeof s.motion_prompt !== 'string' || !s.motion_prompt.trim()) {
              throw new BadRequestException('kling scene requires motion_prompt');
            }
            klingCount++;
            isFirstKling = false;
          } else {
            isFirstKling = true; // imagen разрывает chain

            if (typeof s.image_prompt !== 'string' || !s.image_prompt.trim()) {
              throw new BadRequestException('imagen scene requires image_prompt');
            }
          }
          if (s.duration !== undefined && (typeof s.duration !== 'number' || s.duration <= 0)) {
            throw new BadRequestException('scene duration must be a positive number');
          }
        }
        if (klingCount > 6) {
          throw new BadRequestException('cannot have more than 6 kling scenes per scenario (cost-контроль)');
        }
        sets.push(`scenes_json = $${i++}::jsonb`); vals.push(JSON.stringify(body.scenes));
        sets.push(`kling_scene_count = $${i++}`); vals.push(klingCount);
      } else {
        // null = clear premium scenes
        sets.push(`scenes_json = NULL`);
        sets.push(`kling_scene_count = 0`);
      }
    }
    if (sets.length === 0) {
      return { ok: true, updated: 0 };
    }
    vals.push(id);
    await this.pg.query(
      `UPDATE smm_scenario SET ${sets.join(', ')} WHERE id = $${i}`,
      vals,
    );
    return { ok: true, updated: sets.length };
  }

  @Delete(':id')
  async reject(@Req() req: any, @Param('id') id: string) {
    await this.assertCanAccessScenario(id, req);
    await this.approval.rejectScenario(id);
    return { ok: true };
  }
}
