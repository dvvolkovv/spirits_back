// src/smm/producer/smm-producer-tools.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { ScenarioService, SourceMode } from './scenario.service';
import { TrendsService } from './trends.service';
import { ApprovalService } from './approval.service';
import { CreatorCampaignService } from './creator-campaign.service';
import { PublicationService } from '../publication/publication.service';
import { OAuthStateService, Platform as OAuthPlatform } from '../oauth/oauth-state.service';
import { VkOAuthService } from '../oauth/vk-oauth.service';
import { YouTubeOAuthService } from '../oauth/youtube-oauth.service';
import { TikTokOAuthService } from '../oauth/tiktok-oauth.service';
import { MetaOAuthService } from '../oauth/meta-oauth.service';
import { parseScheduleTime } from '../publication/time-parser';
import { SmmCreatorVoiceGender, SmmCreatorGenre } from '../entities/smm-creator-campaign.entity';

export interface ToolContext {
  userId: string;
  isAdmin: boolean;
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
    private readonly creatorCampaigns: CreatorCampaignService,
    private readonly publication: PublicationService,
    private readonly oauthState: OAuthStateService,
    private readonly vk: VkOAuthService,
    private readonly yt: YouTubeOAuthService,
    private readonly tt: TikTokOAuthService,
    private readonly meta: MetaOAuthService,
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
        case 'connect_social':       return await this.connectSocial(input, ctx);
        case 'schedule_publication': return await this.schedulePublication(input, ctx);
        case 'cancel_publication':   return await this.cancelPublication(input);
        case 'list_publications':    return await this.listPublications(input, ctx);
        case 'set_creator_campaign_settings': {
          const camp = await this.getOrCreateDraftCampaign(ctx.userId, ctx.isAdmin);
          const settings = await this.creatorCampaigns.upsert({
            campaignId: camp.id,
            ctaHandle: input.cta_handle,
            ctaLabel: input.cta_label,
            voiceGender: input.voice_gender as SmmCreatorVoiceGender,
            genre: input.genre as SmmCreatorGenre | undefined,
          });
          return { ok: true, campaignId: camp.id, settings };
        }
        default:
          return { error: `unknown tool: ${toolName}` };
      }
    } catch (err: any) {
      this.logger.error(`tool ${toolName} failed: ${err.message}`);
      return { error: err.message };
    }
  }

  private async generateScenarios(
    input: { mode: SourceMode; count: number; topic?: string; premium_genre?: 'surreal' | 'pov' | 'cinematic' | null },
    ctx: ToolContext,
  ): Promise<{ campaignId: string; scenarios: Array<{ id: string; title: string }> }> {
    // 1. Resolve campaign — reuse draft from set_creator_campaign_settings if any.
    const campaign = await this.getOrCreateDraftCampaign(ctx.userId, ctx.isAdmin);
    const campaignId = campaign.id;
    await this.pg.query(
      `UPDATE smm_campaign
         SET source_mode = $1,
             requested_count = $2,
             topic = $3
       WHERE id = $4`,
      [input.mode, input.count, input.topic ?? null, campaignId],
    );

    // 2. For trends mode — fetch trends context
    let trendsContext: string | undefined;
    if (input.mode === 'trends') {
      const trends = await this.trends.fetchTrendingTopics();
      if (trends) trendsContext = trends;
      else this.logger.warn('trends unavailable, falling back to auto-mode generation');
    }

    // 3. Generate — premium доступен всем юзерам
    const premiumGenre = input.premium_genre ?? null;
    const ids = await this.scenario.generate({
      campaignId,
      mode: input.mode,
      count: input.count,
      topic: input.topic ?? null,
      trendsContext,
      premiumGenre,
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

  private async connectSocial(input: { platform: string }, ctx: ToolContext): Promise<{
    platform: string;
    method: 'oauth' | 'manual';
    authorizeUrl?: string;
    instructions?: string;
  }> {
    if (input.platform === 'telegram') {
      return {
        platform: 'telegram',
        method: 'manual',
        instructions:
          'Создай бота через @BotFather, добавь его как администратора в свой канал, ' +
          'затем напиши боту первое сообщение чтобы получить chat_id (или используй @username канала). ' +
          'Затем отправь POST на /webhook/smm/social-accounts/telegram с { botToken, chatId, displayName? }.',
      };
    }
    if (!['vk', 'youtube', 'tiktok', 'instagram'].includes(input.platform)) {
      throw new Error(`unsupported platform: ${input.platform}`);
    }
    const stateToken = await this.oauthState.create(ctx.userId, input.platform as OAuthPlatform);
    let authorizeUrl: string;
    switch (input.platform) {
      case 'vk':        authorizeUrl = this.vk.buildAuthorizeUrl(stateToken); break;
      case 'youtube':   authorizeUrl = this.yt.buildAuthorizeUrl(stateToken); break;
      case 'tiktok':    authorizeUrl = this.tt.buildAuthorizeUrl(stateToken); break;
      case 'instagram': authorizeUrl = this.meta.buildAuthorizeUrl(stateToken); break;
      default: throw new Error(`unsupported`);
    }
    return { platform: input.platform, method: 'oauth', authorizeUrl };
  }

  private async schedulePublication(
    input: { video_id: string; platforms: string[]; scheduled_time?: string; caption?: string },
    ctx: ToolContext,
  ) {
    const scheduledAt = parseScheduleTime(input.scheduled_time ?? null);
    const result = await this.publication.schedulePublications({
      userId: ctx.userId,
      videoId: input.video_id,
      platforms: input.platforms as any[],
      scheduledAt,
      caption: input.caption,
    });
    return result;
  }

  private async cancelPublication(input: { publication_id: string }): Promise<{ ok: true }> {
    await this.publication.cancel(input.publication_id);
    return { ok: true };
  }

  private async listPublications(
    input: { status?: string; video_id?: string },
    ctx: ToolContext,
  ) {
    const rows = await this.publication.listForUser(ctx.userId, {
      status: input.status,
      videoId: input.video_id,
    });
    return {
      publications: rows.map((p) => ({
        id: p.id,
        videoId: p.videoId,
        platform: p.platform,
        status: p.status,
        scheduledAt: p.scheduledAt,
        publishedAt: p.publishedAt,
        externalUrl: p.externalUrl,
      })),
    };
  }

  /**
   * Return the latest draft campaign for the user, or create a new one if none
   * exists. is_linkeon_official mirrors the caller's admin status at creation
   * time (creator-mode flag for Task 3).
   */
  private async getOrCreateDraftCampaign(userId: string, isAdmin: boolean): Promise<{ id: string }> {
    const existing = await this.pg.query(
      `SELECT id FROM smm_campaign
        WHERE user_id = $1 AND status = 'drafting'
        ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (existing.rows[0]?.id) return { id: existing.rows[0].id };

    const created = await this.pg.query(
      `INSERT INTO smm_campaign (user_id, source_mode, requested_count, status, is_linkeon_official)
       VALUES ($1, 'auto', 1, 'drafting', $2) RETURNING id`,
      [userId, isAdmin],
    );
    return { id: created.rows[0].id };
  }
}
