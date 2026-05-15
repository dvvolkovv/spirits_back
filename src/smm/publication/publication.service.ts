// src/smm/publication/publication.service.ts
import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { PublishQueueService, PublishJobPayload } from './publish-queue.service';
import {
  SmmPublication,
  SmmPlatform,
  rowToPublication,
} from '../entities/smm-publication.entity';

export type Platform = SmmPlatform;

export interface SchedulePublicationsInput {
  userId: string;
  videoId: string;
  platforms: Platform[];
  /** ISO string. null = publish immediately. */
  scheduledAt: Date | null;
  caption?: string;
}

export interface ScheduleResult {
  scheduled: Array<{ publicationId: string; platform: Platform; jobId: string; scheduledAt: string | null }>;
  failed:    Array<{ platform: Platform; reason: 'no_account' | 'video_not_ready' | 'duplicate' | 'error'; detail?: string }>;
}

@Injectable()
export class PublicationService {
  private readonly logger = new Logger(PublicationService.name);

  constructor(
    private readonly pg: PgService,
    private readonly queue: PublishQueueService,
  ) {}

  async schedulePublications(input: SchedulePublicationsInput): Promise<ScheduleResult> {
    const result: ScheduleResult = { scheduled: [], failed: [] };

    // 1. Verify video belongs to user + status = approved (or ready)
    const vRes = await this.pg.query(
      `SELECT v.id, v.status, c.user_id
         FROM smm_video v
         JOIN smm_scenario s ON s.id = v.scenario_id
         JOIN smm_campaign c ON c.id = s.campaign_id
        WHERE v.id = $1`,
      [input.videoId],
    );
    if (vRes.rows.length === 0) throw new NotFoundException(`video ${input.videoId} not found`);
    const v = vRes.rows[0];
    if (v.user_id !== input.userId) throw new ForbiddenException(`video does not belong to user`);
    if (v.status !== 'approved' && v.status !== 'ready') {
      throw new BadRequestException(`video status is ${v.status}, must be approved or ready`);
    }

    for (const platform of input.platforms) {
      try {
        // 2. Verify user has a social account for this platform
        const acc = await this.pg.query(
          `SELECT id FROM smm_social_account
            WHERE platform = $1 AND status = 'active'
              AND (user_id = $2 OR user_id IS NULL)
            ORDER BY user_id NULLS LAST LIMIT 1`,
          [platform, input.userId],
        );
        if (acc.rows.length === 0) {
          result.failed.push({ platform, reason: 'no_account' });
          continue;
        }

        // 3. Check for existing publication on this (video, platform) — UNIQUE constraint
        const existing = await this.pg.query(
          `SELECT id, status FROM smm_publication
            WHERE video_id = $1 AND platform = $2`,
          [input.videoId, platform],
        );
        if (existing.rows.length > 0) {
          result.failed.push({
            platform, reason: 'duplicate',
            detail: `already ${existing.rows[0].status}`,
          });
          continue;
        }

        // 4. Insert publication row
        const initialStatus = input.scheduledAt ? 'scheduled' : 'scheduled'; // both 'scheduled'; worker flips to 'publishing'
        const pRes = await this.pg.query(
          `INSERT INTO smm_publication
              (video_id, platform, scheduled_at, status, caption)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [
            input.videoId, platform,
            input.scheduledAt ?? null,
            initialStatus,
            input.caption ?? null,
          ],
        );
        const publicationRow = pRes.rows[0];
        const publicationId = publicationRow.id;

        // 5. Enqueue BullMQ job with optional delay
        const delayMs = input.scheduledAt
          ? Math.max(0, input.scheduledAt.getTime() - Date.now())
          : 0;
        const payload: PublishJobPayload = { publicationId, videoId: input.videoId, platform };
        const jobId = await this.queue.enqueue(payload, delayMs > 0 ? { delay: delayMs } : undefined);

        await this.pg.query(
          `UPDATE smm_publication SET publish_job_id = $1 WHERE id = $2`,
          [jobId, publicationId],
        );

        result.scheduled.push({
          publicationId,
          platform,
          jobId,
          scheduledAt: input.scheduledAt ? input.scheduledAt.toISOString() : null,
        });
        this.logger.log(`Scheduled ${platform} pub ${publicationId} (job ${jobId}, delay ${delayMs}ms)`);
      } catch (err: any) {
        result.failed.push({ platform, reason: 'error', detail: err.message });
        this.logger.error(`Failed to schedule ${platform}: ${err.message}`);
      }
    }

    return result;
  }

  async cancel(publicationId: string): Promise<void> {
    const r = await this.pg.query(
      `SELECT publish_job_id, status FROM smm_publication WHERE id = $1`,
      [publicationId],
    );
    if (r.rows.length === 0) throw new NotFoundException(`publication ${publicationId}`);
    const row = r.rows[0];
    if (row.status === 'publishing') {
      throw new BadRequestException(`publication is already publishing — cannot cancel`);
    }
    if (row.status !== 'scheduled') {
      // already published/failed/cancelled — no-op
      return;
    }
    if (row.publish_job_id) {
      try { await this.queue.cancel(row.publish_job_id); } catch (e: any) {
        this.logger.warn(`failed to remove BullMQ job ${row.publish_job_id}: ${e.message}`);
      }
    }
    await this.pg.query(
      `UPDATE smm_publication SET status = 'cancelled' WHERE id = $1`,
      [publicationId],
    );
    this.logger.log(`Cancelled publication ${publicationId}`);
  }

  async listForUser(userId: string, filter?: { status?: string; videoId?: string }): Promise<SmmPublication[]> {
    const where = [`c.user_id = $1`];
    const args: any[] = [userId];
    if (filter?.status) {
      where.push(`p.status = $${args.length + 1}`);
      args.push(filter.status);
    }
    if (filter?.videoId) {
      where.push(`p.video_id = $${args.length + 1}`);
      args.push(filter.videoId);
    }
    const sql = `
      SELECT p.*
        FROM smm_publication p
        JOIN smm_video v ON v.id = p.video_id
        JOIN smm_scenario s ON s.id = v.scenario_id
        JOIN smm_campaign c ON c.id = s.campaign_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.created_at DESC
       LIMIT 50`;
    const r = await this.pg.query(sql, args);
    return r.rows.map(rowToPublication);
  }

  async getById(publicationId: string): Promise<SmmPublication | null> {
    const r = await this.pg.query(`SELECT * FROM smm_publication WHERE id = $1`, [publicationId]);
    return r.rows[0] ? rowToPublication(r.rows[0]) : null;
  }
}
