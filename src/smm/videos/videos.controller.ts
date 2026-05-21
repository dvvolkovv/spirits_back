// src/smm/videos/videos.controller.ts
import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Body, Req, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { PgService } from '../../common/services/pg.service';
import { rowToVideo } from '../entities/smm-video.entity';
import { ApprovalService } from '../producer/approval.service';
import { PublicationService, Platform } from '../publication/publication.service';
import { parseScheduleTime } from '../publication/time-parser';
import { SmmBillingService } from '../billing/smm-billing.service';
import { SmmPremiumGenerationService } from '../billing/smm-premium-generation.service';
import { InsufficientTokensError } from '../billing/insufficient-tokens.error';
import { RenderQueueService } from '../render/render-queue.service';
import { PremiumGenre } from '../entities/smm-scenario.entity';

@Controller('smm/videos')
@UseGuards(JwtGuard)
export class VideosController {
  constructor(
    private readonly pg: PgService,
    private readonly approval: ApprovalService,
    private readonly publication: PublicationService,
    private readonly billing: SmmBillingService,
    private readonly premiumGen: SmmPremiumGenerationService,
    private readonly renderQueue: RenderQueueService,
  ) {}

  /**
   * Admins can read/modify any video; non-admins only their own (via campaign.user_id).
   */
  private async assertCanAccessVideo(videoId: string, req: any): Promise<void> {
    const r = await this.pg.query(
      `SELECT c.user_id
         FROM smm_video v
         JOIN smm_scenario s ON s.id = v.scenario_id
         JOIN smm_campaign c ON c.id = s.campaign_id
        WHERE v.id = $1`,
      [videoId],
    );
    if (r.rows.length === 0) throw new NotFoundException(`video ${videoId} not found`);
    if (req.user?.isAdmin) return;
    if (r.rows[0].user_id !== req.user?.phone) {
      throw new ForbiddenException('not your video');
    }
  }

  @Get(':id')
  async getOne(@Req() req: any, @Param('id') id: string) {
    await this.assertCanAccessVideo(id, req);
    const r = await this.pg.query(`SELECT * FROM smm_video WHERE id = $1`, [id]);
    if (r.rows.length === 0) throw new NotFoundException(`video ${id} not found`);
    return rowToVideo(r.rows[0]);
  }

  /**
   * Список всех видео, принадлежащих текущему юзеру (через campaign.user_id).
   * Возвращает готовые/неготовые, отсортировано по created_at DESC. Лимит 100.
   * Включаем title из сценария и premium_genre для UI-бейджа.
   */
  @Get()
  async listMine(@Req() req: any) {
    if (!req.user?.phone) {
      throw new ForbiddenException('not authenticated');
    }
    const r = await this.pg.query(
      `SELECT v.id, v.status, v.mp4_url, v.duration_sec, v.size_bytes,
              v.tokens_charged, v.created_at, v.updated_at,
              s.title, s.assistant_role, s.mood, s.premium_genre
         FROM smm_video v
         JOIN smm_scenario s ON s.id = v.scenario_id
         JOIN smm_campaign c ON c.id = s.campaign_id
        WHERE c.user_id = $1
        ORDER BY v.created_at DESC
        LIMIT 100`,
      [req.user.phone],
    );
    return r.rows.map((row: any) => ({
      id: row.id,
      status: row.status,
      mp4Url: row.mp4_url,
      durationSec: row.duration_sec,
      sizeBytes: row.size_bytes,
      tokensCharged: Number(row.tokens_charged ?? 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      assistantRole: row.assistant_role,
      mood: row.mood,
      premiumGenre: row.premium_genre,
    }));
  }

  @Post(':id/approve')
  async approve(@Req() req: any, @Param('id') id: string) {
    await this.assertCanAccessVideo(id, req);
    await this.approval.approveVideo(id);
    return { ok: true };
  }

  @Post(':id/reject')
  async reject(@Req() req: any, @Param('id') id: string, @Body() body: { reason?: string }) {
    await this.assertCanAccessVideo(id, req);
    await this.approval.rejectVideo(id, body?.reason);
    return { ok: true };
  }

  /**
   * Regenerate a video — same scenario, new render (new TTS + b-roll).
   * Charges tokens again (no refund of the previous charge). The previous
   * mp4_url is preserved in render_state.previous_versions for audit.
   *
   * Allowed when status is one of: ready, approved, failed, rejected
   * (i.e. NOT queued/rendering — would conflict with the in-flight job).
   */
  /**
   * Escape hatch — пользователь сделал выбор после того как премиум-pipeline
   * исчерпал retries на одной из kling-сцен (status === 'escape_hatch_offered').
   *
   * Варианты body.choice:
   *   - 'refund': 100% возврат, видео отменено (cancelled), generation = full_refund
   *   - 'keep_static': 50% возврат, premium_genre сбрасывается в NULL,
   *      сценарий перерендеривается в «классике» без kling (queued).
   *   - 'switch_genre': 100% возврат, scenario.premium_genre = newGenre,
   *      видео отменено; юзер должен запустить новую генерацию заново (другая цена).
   */
  @Post(':id/escape-hatch')
  async escapeHatch(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { choice: 'refund' | 'keep_static' | 'switch_genre'; newGenre?: PremiumGenre },
  ) {
    await this.assertCanAccessVideo(id, req);
    const vRes = await this.pg.query(
      `SELECT status, scenario_id FROM smm_video WHERE id = $1`,
      [id],
    );
    if (vRes.rows.length === 0) throw new NotFoundException(`video ${id} not found`);
    if (vRes.rows[0].status !== 'escape_hatch_offered') {
      throw new BadRequestException(`video ${id} is ${vRes.rows[0].status}, not escape_hatch_offered`);
    }
    const scenarioId = vRes.rows[0].scenario_id;

    const gen = await this.premiumGen.findByVideoId(id);
    if (!gen) throw new NotFoundException(`no premium generation for video ${id}`);

    if (body.choice === 'refund') {
      // 100% возврат премиум + TTS (видео так и не доставлено).
      await this.premiumGen.refund({
        generationId: gen.id, refundTokens: gen.tokensCharged, status: 'full_refund',
      });
      await this.billing.refund({ videoId: id, reason: 'escape_hatch_refund' });
      await this.pg.query(`UPDATE smm_video SET status = 'cancelled' WHERE id = $1`, [id]);
      return { ok: true, refunded: gen.tokensCharged };
    }

    if (body.choice === 'keep_static') {
      const half = Math.floor(gen.tokensCharged / 2);
      await this.premiumGen.refund({
        generationId: gen.id, refundTokens: half, status: 'partial_refund',
      });
      // Сбрасываем premium-разметку → re-render как классика
      await this.pg.query(
        `UPDATE smm_scenario SET premium_genre = NULL, kling_scene_count = 0, scenes_json = NULL
          WHERE id = $1`,
        [scenarioId],
      );
      await this.pg.query(
        `UPDATE smm_video
            SET status = 'queued',
                render_state = jsonb_build_object('previous_premium_attempt', render_state->'escape_hatch')
          WHERE id = $1`,
        [id],
      );
      const jobId = await this.renderQueue.enqueue({ videoId: id, scenarioId });
      await this.pg.query(`UPDATE smm_video SET render_job_id = $1 WHERE id = $2`, [jobId, id]);
      return { ok: true, refunded: half, requeued: true };
    }

    if (body.choice === 'switch_genre') {
      if (!body.newGenre || !['surreal', 'pov', 'cinematic'].includes(body.newGenre)) {
        throw new BadRequestException('newGenre required and must be surreal|pov|cinematic');
      }
      // 100% возврат премиум + TTS — юзер пересоздаёт ролик с нуля,
      // на новой генерации будет новая charge-транзакция.
      await this.premiumGen.refund({
        generationId: gen.id, refundTokens: gen.tokensCharged, status: 'full_refund',
      });
      await this.billing.refund({ videoId: id, reason: 'escape_hatch_switch_genre' });
      // Меняем жанр на сценарии. Юзер сам должен подтвердить новую цену через UI
      // (preview + confirm) — фронт перезапускает /scenarios/:id/render с новым жанром.
      await this.pg.query(
        `UPDATE smm_scenario SET premium_genre = $1, scenes_json = NULL, kling_scene_count = 0
          WHERE id = $2`,
        [body.newGenre, scenarioId],
      );
      await this.pg.query(`UPDATE smm_video SET status = 'cancelled' WHERE id = $1`, [id]);
      return { ok: true, refunded: gen.tokensCharged, switched_to: body.newGenre };
    }

    throw new BadRequestException(`unknown choice: ${body.choice}`);
  }

  @Post(':id/regenerate')
  async regenerate(@Req() req: any, @Param('id') id: string) {
    await this.assertCanAccessVideo(id, req);
    const vRes = await this.pg.query(
      `SELECT v.id, v.status, v.scenario_id, v.mp4_url, v.duration_sec, v.size_bytes,
              v.render_state, s.tts_tier, c.user_id
         FROM smm_video v
         JOIN smm_scenario s ON s.id = v.scenario_id
         JOIN smm_campaign c ON c.id = s.campaign_id
        WHERE v.id = $1`,
      [id],
    );
    if (vRes.rows.length === 0) throw new NotFoundException(`video ${id} not found`);
    const row = vRes.rows[0];
    if (!['ready', 'approved', 'failed', 'rejected'].includes(row.status)) {
      throw new BadRequestException(`video ${id} is ${row.status}, cannot regenerate`);
    }

    // Snapshot the current version into render_state.previous_versions
    const prevState = (row.render_state && typeof row.render_state === 'object') ? row.render_state : {};
    const prev = Array.isArray(prevState.previous_versions) ? prevState.previous_versions : [];
    prev.push({
      mp4Url: row.mp4_url,
      durationSec: row.duration_sec,
      sizeBytes: row.size_bytes,
      replacedAt: new Date().toISOString(),
    });

    // CRITICAL: render_state contains idempotency flags (remotionRendered,
    // voicesSynthesized, imagesGenerated, stockVideosDownloaded, …) which the
    // pipeline uses to short-circuit already-completed steps. Wiping the whole
    // state preserves only previous_versions for audit — every step rebuilds
    // from scratch, producing a fresh mp4 with new TTS and new b-roll.
    await this.pg.query(
      `UPDATE smm_video
          SET status = 'queued',
              mp4_url = NULL,
              duration_sec = NULL,
              size_bytes = NULL,
              error_message = NULL,
              render_state = jsonb_build_object('previous_versions', $2::jsonb)
        WHERE id = $1`,
      [id, JSON.stringify(prev)],
    );

    try {
      await this.billing.charge({
        userId: row.user_id,
        videoId: id,
        tier: row.tts_tier,
      });
    } catch (err: any) {
      if (err instanceof InsufficientTokensError) {
        // Revert status so the user can try again after topping up
        await this.pg.query(`UPDATE smm_video SET status = 'failed', error_message = 'insufficient_tokens' WHERE id = $1`, [id]);
        throw new BadRequestException('insufficient_tokens');
      }
      throw err;
    }

    const jobId = await this.renderQueue.enqueue({ videoId: id, scenarioId: row.scenario_id });
    await this.pg.query(`UPDATE smm_video SET render_job_id = $1 WHERE id = $2`, [jobId, id]);

    // Attribute the new charge to the chat message that originally introduced
    // this scenario, so "X токенов" suffix shows full lifetime cost.
    try {
      const cRes = await this.pg.query(`SELECT tokens_charged FROM smm_video WHERE id = $1`, [id]);
      const charge = Number(cRes.rows[0]?.tokens_charged ?? 0);
      await this.pg.query(
        `UPDATE custom_chat_history
            SET tokens_used = COALESCE(tokens_used, 0) + $1
          WHERE id = (
            SELECT id FROM custom_chat_history
             WHERE sender_type = 'ai'
               AND position('smm_scenario:id=' || $2::text in content) > 0
             ORDER BY created_at DESC LIMIT 1
          )`,
        [charge, row.scenario_id],
      );
    } catch { /* ignore */ }

    return { ok: true, videoId: id, jobId };
  }

  /**
   * Publish (or schedule) a video to one or more platforms.
   * If video status is 'ready' (not yet approved), auto-approves it first.
   *
   * Body:
   *   platforms: Platform[]  (required, ≥1)
   *   scheduledTime?: string ('сейчас' / 'завтра в 18' / ISO / null = now)
   *   caption?: string
   */
  @Post(':id/publish')
  async publish(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { platforms: Platform[]; scheduledTime?: string; caption?: string },
  ) {
    if (!Array.isArray(body?.platforms) || body.platforms.length === 0) {
      throw new NotFoundException('platforms is required');
    }
    await this.assertCanAccessVideo(id, req);
    // Look up video → its scenario → campaign.user_id (for authz + scheduling).
    const vRes = await this.pg.query(
      `SELECT v.id, v.status, c.user_id
         FROM smm_video v
         JOIN smm_scenario s ON s.id = v.scenario_id
         JOIN smm_campaign c ON c.id = s.campaign_id
        WHERE v.id = $1`,
      [id],
    );
    if (vRes.rows.length === 0) throw new NotFoundException(`video ${id} not found`);
    const v = vRes.rows[0];

    // Auto-approve if still 'ready' — saves an extra round-trip from the UI.
    if (v.status === 'ready') {
      await this.approval.approveVideo(id);
    }

    const scheduledAt = parseScheduleTime(body.scheduledTime ?? null);
    const result = await this.publication.schedulePublications({
      userId: v.user_id,
      videoId: id,
      platforms: body.platforms,
      scheduledAt,
      caption: body.caption,
    });
    return result;
  }
}
