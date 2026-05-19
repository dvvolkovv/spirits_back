// src/smm/videos/videos.controller.ts
import { Controller, Get, NotFoundException, Param, Post, Body, Req, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PgService } from '../../common/services/pg.service';
import { rowToVideo } from '../entities/smm-video.entity';
import { ApprovalService } from '../producer/approval.service';
import { PublicationService, Platform } from '../publication/publication.service';
import { parseScheduleTime } from '../publication/time-parser';

@Controller('smm/videos')
@UseGuards(JwtGuard, AdminGuard)
export class VideosController {
  constructor(
    private readonly pg: PgService,
    private readonly approval: ApprovalService,
    private readonly publication: PublicationService,
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
