import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Content generation metrics — see monitoring.functions.md §3.7.
 *
 * Sources:
 * - generated_images (only successful rows; failure tracking lives elsewhere)
 * - video_jobs (status pending/processing/completed/failed, duration_sec,
 *   tokens_spent, updated_at)
 * - dozvon_calls (status + duration_sec actual + tokens_spent)
 */

export type ContentWindow = '24h' | '7d' | '30d' | '90d' | 'all';

const WINDOW_INTERVAL: Record<ContentWindow, string> = {
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
  '90d': '90 days',
  'all': '100 years',
};

const DEFAULT_EXCLUDED = ['70000000000', '79030169187'];
const EXCLUDED = (process.env.FUNNEL_EXCLUDED_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const excluded = EXCLUDED.length > 0 ? EXCLUDED : DEFAULT_EXCLUDED;

export interface ContentOverview {
  window: ContentWindow;
  generatedAt: string;
  excludedUsers: string[];

  images: {
    total: number;
    uniqueUsers: number;
    avgTokens: number | null;
  };
  videos: {
    total: number;
    completed: number;
    failed: number;
    inFlight: number;          // pending + processing
    successRatePct: number | null;
    avgWaitSeconds: number | null;  // updated_at - created_at for completed
    avgTokens: number | null;
  };
  dozvon: {
    total: number;
    completed: number;
    completionRatePct: number | null;
    avgDurationSec: number | null;
  };
}

@Injectable()
export class ContentService {
  private readonly log = new Logger(ContentService.name);
  constructor(private readonly pg: PgService) {}

  private async one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    try {
      const r = await this.pg.query(sql, params);
      return r.rows[0] || null;
    } catch (e: any) {
      this.log.error(`content query failed: ${e.message}`);
      return null;
    }
  }

  async getOverview(window: ContentWindow): Promise<ContentOverview> {
    const interval = WINDOW_INTERVAL[window];
    const inWindow = (col = 'created_at') => `($1 = 'all' OR ${col} >= now() - $2::interval)`;

    const images = await this.one<any>(
      `SELECT
         COUNT(*)::int                   AS total,
         COUNT(DISTINCT user_id)::int    AS unique_users,
         AVG(tokens_spent)::numeric(10,1) AS avg_tokens
       FROM generated_images
       WHERE user_id <> ALL($3::text[])
         AND ${inWindow('created_at')}`,
      [window, interval, excluded],
    );

    // video_jobs uses 'ready' for completed (Kling's status name); dozvon
    // uses 'done'. We accept the common variants so the same code works
    // across both tables.
    const COMPLETED = "('completed','succeeded','done','ready')";
    const FAILED    = "('failed','error')";
    const IN_FLIGHT = "('pending','processing','queued')";

    const videos = await this.one<any>(
      `WITH v AS (
         SELECT * FROM video_jobs
         WHERE user_id <> ALL($3::text[])
           AND ${inWindow('created_at')}
       )
       SELECT
         COUNT(*)::int                                                AS total,
         COUNT(*) FILTER (WHERE status IN ${COMPLETED})::int          AS completed,
         COUNT(*) FILTER (WHERE status IN ${FAILED})::int             AS failed,
         COUNT(*) FILTER (WHERE status IN ${IN_FLIGHT})::int          AS in_flight,
         AVG(tokens_spent)::numeric(10,1)                             AS avg_tokens,
         (SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) FROM v
          WHERE status IN ${COMPLETED})                               AS avg_wait_sec
       FROM v`,
      [window, interval, excluded],
    );

    const dozvon = await this.one<any>(
      `SELECT
         COUNT(*)::int                                                AS total,
         COUNT(*) FILTER (WHERE status IN ${COMPLETED})::int          AS completed,
         AVG(duration_sec) FILTER (WHERE duration_sec IS NOT NULL)::numeric(10,1) AS avg_duration_sec
       FROM dozvon_calls
       WHERE ${inWindow('created_at')}`,
      [window, interval],
    );

    const videosTotal = parseInt(videos?.total || '0', 10);
    const videosCompleted = parseInt(videos?.completed || '0', 10);
    const videosFailed = parseInt(videos?.failed || '0', 10);
    const dozvonTotal = parseInt(dozvon?.total || '0', 10);
    const dozvonCompleted = parseInt(dozvon?.completed || '0', 10);
    const videosFinished = videosCompleted + videosFailed;

    return {
      window,
      generatedAt: new Date().toISOString(),
      excludedUsers: excluded,
      images: {
        total: parseInt(images?.total || '0', 10),
        uniqueUsers: parseInt(images?.unique_users || '0', 10),
        avgTokens: images?.avg_tokens !== null && images?.avg_tokens !== undefined
          ? Number(images.avg_tokens) : null,
      },
      videos: {
        total: videosTotal,
        completed: videosCompleted,
        failed: videosFailed,
        inFlight: parseInt(videos?.in_flight || '0', 10),
        successRatePct: videosFinished > 0 ? (videosCompleted / videosFinished) * 100 : null,
        avgWaitSeconds: videos?.avg_wait_sec !== null && videos?.avg_wait_sec !== undefined
          ? Number(videos.avg_wait_sec) : null,
        avgTokens: videos?.avg_tokens !== null && videos?.avg_tokens !== undefined
          ? Number(videos.avg_tokens) : null,
      },
      dozvon: {
        total: dozvonTotal,
        completed: dozvonCompleted,
        completionRatePct: dozvonTotal > 0 ? (dozvonCompleted / dozvonTotal) * 100 : null,
        avgDurationSec: dozvon?.avg_duration_sec !== null && dozvon?.avg_duration_sec !== undefined
          ? Number(dozvon.avg_duration_sec) : null,
      },
    };
  }
}
