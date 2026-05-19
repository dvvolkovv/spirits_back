// src/smm/videos/videos.controller.ts
import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Body, Req, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PgService } from '../../common/services/pg.service';
import { rowToVideo } from '../entities/smm-video.entity';
import { ApprovalService } from '../producer/approval.service';
import { PublicationService, Platform } from '../publication/publication.service';
import { parseScheduleTime } from '../publication/time-parser';
import { SmmBillingService } from '../billing/smm-billing.service';
import { InsufficientTokensError } from '../billing/insufficient-tokens.error';
import { RenderQueueService } from '../render/render-queue.service';

@Controller('smm/videos')
@UseGuards(JwtGuard, AdminGuard)
export class VideosController {
  constructor(
    private readonly pg: PgService,
    private readonly approval: ApprovalService,
    private readonly publication: PublicationService,
    private readonly billing: SmmBillingService,
    private readonly renderQueue: RenderQueueService,
  ) {}

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const r = await this.pg.query(`SELECT * FROM smm_video WHERE id = $1`, [id]);
    if (r.rows.length === 0) throw new NotFoundException(`video ${id} not found`);
    return rowToVideo(r.rows[0]);
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string) {
    await this.approval.approveVideo(id);
    return { ok: true };
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string, @Body() body: { reason?: string }) {
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
  @Post(':id/regenerate')
  async regenerate(@Req() req: any, @Param('id') id: string) {
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

    await this.pg.query(
      `UPDATE smm_video
          SET status = 'queued',
              mp4_url = NULL,
              duration_sec = NULL,
              size_bytes = NULL,
              error_message = NULL,
              render_state = jsonb_set(
                COALESCE(render_state, '{}'::jsonb),
                '{previous_versions}',
                $2::jsonb,
                true
              )
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
