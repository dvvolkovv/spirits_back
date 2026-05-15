// src/smm/producer/smm-producer-tools.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { ScenarioService, SourceMode } from './scenario.service';
import { TrendsService } from './trends.service';
import { ApprovalService } from './approval.service';

export interface ToolContext {
  userId: string;
  /** Most recent campaign id this user opened in the current chat session (optional). */
  recentCampaignId?: string;
}

@Injectable()
export class SmmProducerToolsService {
  private readonly logger = new Logger(SmmProducerToolsService.name);

  constructor(
    private readonly pg: PgService,
    private readonly scenario: ScenarioService,
    private readonly trends: TrendsService,
    private readonly approval: ApprovalService,
  ) {}

  async handle(toolName: string, input: any, ctx: ToolContext): Promise<any> {
    try {
      switch (toolName) {
        case 'generate_scenarios': return await this.generateScenarios(input, ctx);
        case 'regenerate_scenario': return await this.regenerateScenario(input);
        case 'approve_scenarios':   return await this.approveScenarios(input, ctx);
        case 'reject_scenario':     return await this.rejectScenario(input);
        case 'approve_video':       return await this.approveVideo(input);
        case 'reject_video':        return await this.rejectVideo(input);
        case 'list_scenarios':      return await this.listScenarios(input, ctx);
        default:
          return { error: `unknown tool: ${toolName}` };
      }
    } catch (err: any) {
      this.logger.error(`tool ${toolName} failed: ${err.message}`);
      return { error: err.message };
    }
  }

  private async generateScenarios(
    input: { mode: SourceMode; count: number; topic?: string },
    ctx: ToolContext,
  ): Promise<{ campaignId: string; scenarios: Array<{ id: string; title: string }> }> {
    // 1. Create campaign
    const cRes = await this.pg.query(
      `INSERT INTO smm_campaign (user_id, source_mode, requested_count, topic, status)
       VALUES ($1, $2, $3, $4, 'drafting') RETURNING id`,
      [ctx.userId, input.mode, input.count, input.topic ?? null],
    );
    const campaignId = cRes.rows[0].id;

    // 2. For trends mode — fetch trends context
    let trendsContext: string | undefined;
    if (input.mode === 'trends') {
      const trends = await this.trends.fetchTrendingTopics();
      if (trends) trendsContext = trends;
      else this.logger.warn('trends unavailable, falling back to auto-mode generation');
    }

    // 3. Generate
    const ids = await this.scenario.generate({
      campaignId,
      mode: input.mode,
      count: input.count,
      topic: input.topic ?? null,
      trendsContext,
    });

    // 4. Return id+title for each
    const rows = await this.pg.query(
      `SELECT id, title FROM smm_scenario WHERE id = ANY($1::uuid[])`, [ids]);
    return {
      campaignId,
      scenarios: rows.rows.map((r: any) => ({ id: r.id, title: r.title })),
    };
  }

  private async regenerateScenario(input: { scenario_id: string; feedback: string }): Promise<{ scenarioId: string; title: string }> {
    await this.scenario.regenerate(input.scenario_id, input.feedback);
    const s = await this.scenario.getById(input.scenario_id);
    if (!s) throw new Error(`scenario ${input.scenario_id} not found after regen`);
    return { scenarioId: s.id, title: s.title };
  }

  private async approveScenarios(input: { scenario_ids: string[] }, ctx: ToolContext) {
    return await this.approval.approveScenarios({
      userId: ctx.userId,
      scenarioIds: input.scenario_ids,
    });
  }

  private async rejectScenario(input: { scenario_id: string }): Promise<{ ok: true }> {
    await this.approval.rejectScenario(input.scenario_id);
    return { ok: true };
  }

  private async approveVideo(input: { video_id: string }): Promise<{ ok: true }> {
    await this.approval.approveVideo(input.video_id);
    return { ok: true };
  }

  private async rejectVideo(input: { video_id: string; reason?: string }): Promise<{ ok: true }> {
    await this.approval.rejectVideo(input.video_id, input.reason);
    return { ok: true };
  }

  private async listScenarios(input: { campaign_id?: string }, ctx: ToolContext): Promise<{ scenarios: Array<{ id: string; title: string; status: string }> }> {
    const query = input.campaign_id
      ? `SELECT id, title, status FROM smm_scenario WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 20`
      : `SELECT s.id, s.title, s.status FROM smm_scenario s
         JOIN smm_campaign c ON c.id = s.campaign_id
         WHERE c.user_id = $1 ORDER BY s.created_at DESC LIMIT 20`;
    const r = await this.pg.query(query, [input.campaign_id ?? ctx.userId]);
    return { scenarios: r.rows };
  }
}
