// src/smm/smm.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PgService } from '../common/services/pg.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { rowToCampaign, SmmCampaign } from './entities/smm-campaign.entity';

@Controller('smm')
@UseGuards(JwtGuard, AdminGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class SmmController {
  constructor(private readonly pg: PgService) {}

  @Post('campaigns')
  async createCampaign(
    @Req() req: any,
    @Body() dto: CreateCampaignDto,
  ): Promise<SmmCampaign> {
    const userId = req.user.userId;
    const res = await this.pg.query(
      `INSERT INTO smm_campaign
          (user_id, conversation_id, topic, source_mode, requested_count)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        userId,
        dto.conversationId ?? null,
        dto.topic ?? null,
        dto.sourceMode,
        dto.requestedCount,
      ],
    );
    return rowToCampaign(res.rows[0]);
  }

  @Get('campaigns/:id')
  async getCampaign(@Param('id') id: string): Promise<SmmCampaign> {
    const res = await this.pg.query(
      `SELECT * FROM smm_campaign WHERE id = $1`, [id],
    );
    if (res.rows.length === 0) throw new NotFoundException(`campaign ${id} not found`);
    return rowToCampaign(res.rows[0]);
  }

  // Admin-only fixture endpoint for the julia-creator Playwright smoke. Creates
  // a campaign + scenario + chat_history row so the test has data to edit.
  // Idempotent per user: previously seeded rows (marked by topic = SEED_MARKER)
  // are deleted before each call, so smoke runs don't accumulate orphans.
  @Post('admin/seed-scenario')
  async seedScenarioForSmoke(
    @Body() dto: { phone: string },
  ): Promise<{ scenarioId: string; campaignId: string; sessionId: string }> {
    if (!dto?.phone) throw new BadRequestException('phone is required');
    const userId = dto.phone;
    const SEED_MARKER = '[smoke-seed]';

    const agentRes = await this.pg.query(
      `SELECT id FROM agents WHERE name = 'smm_producer' LIMIT 1`,
    );
    if (agentRes.rows.length === 0) {
      throw new NotFoundException('smm_producer agent not found');
    }
    const smmAgentId: number = agentRes.rows[0].id;
    const sessionId = `${userId}_${smmAgentId}`;

    // Cleanup prior seed rows (smm_scenario cascades from smm_campaign).
    await this.pg.query(
      `DELETE FROM smm_campaign WHERE user_id = $1 AND topic = $2`,
      [userId, SEED_MARKER],
    );
    await this.pg.query(
      `DELETE FROM custom_chat_history
       WHERE session_id = $1 AND content LIKE '%' || $2 || '%'`,
      [sessionId, SEED_MARKER],
    );

    const campRes = await this.pg.query(
      `INSERT INTO smm_campaign (user_id, topic, source_mode, requested_count)
       VALUES ($1, $2, 'topic', 1)
       RETURNING id`,
      [userId, SEED_MARKER],
    );
    const campaignId: string = campRes.rows[0].id;

    const scenRes = await this.pg.query(
      `INSERT INTO smm_scenario
         (campaign_id, title, assistant_role, dialog, mood)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        campaignId,
        `${SEED_MARKER} starter scenario ${new Date().toISOString()}`,
        'psy',
        JSON.stringify([
          { speaker: 'hero', text: 'Smoke seed placeholder.', tStart: 0, tEnd: 1 },
          { speaker: 'assistant', text: 'Smoke seed reply.', tStart: 1, tEnd: 2 },
        ]),
        'neutral',
      ],
    );
    const scenarioId: string = scenRes.rows[0].id;

    await this.pg.query(
      `INSERT INTO custom_chat_history
         (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'ai', $2, $3, 'text')`,
      [
        sessionId,
        smmAgentId,
        `${SEED_MARKER} Готовый сценарий для теста:\n\n{{smm_scenario:id=${scenarioId}}}`,
      ],
    );

    return { scenarioId, campaignId, sessionId };
  }
}
