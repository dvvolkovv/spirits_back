import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Networking metrics — see monitoring.functions.md §3.4.
 *
 * Reads from existing tables (contact_requests, user_blocks) — does NOT
 * touch the events stream yet because search/contact_request_sent
 * events aren't emitted by the app today. When those are added, the
 * service will pick them up via a follow-up PR.
 */

export type NetworkingWindow = '24h' | '7d' | '30d' | '90d' | 'all';

const WINDOW_INTERVAL: Record<NetworkingWindow, string> = {
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
  '90d': '90 days',
  'all': '100 years',
};

export interface NetworkingOverview {
  window: NetworkingWindow;
  generatedAt: string;

  requests: {
    total: number;
    pending: number;
    approved: number;
    declined: number;
    acceptRatePct: number | null;        // approved / (approved + declined)
    medianTimeToAcceptHours: number | null;
    pendingOlder24h: number;             // queue depth — pending >24h old
  };

  blocks: {
    total: number;
    inWindow: number;
  };

  topRequesters: Array<{ userId: string; sent: number; accepted: number }>;
  topTargets:    Array<{ userId: string; received: number; accepted: number }>;
}

@Injectable()
export class NetworkingService {
  private readonly log = new Logger(NetworkingService.name);

  constructor(private readonly pg: PgService) {}

  private async one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    try {
      const r = await this.pg.query(sql, params);
      return r.rows[0] || null;
    } catch (e: any) {
      this.log.error(`networking query failed: ${e.message}`);
      return null;
    }
  }

  async getOverview(window: NetworkingWindow): Promise<NetworkingOverview> {
    const interval = WINDOW_INTERVAL[window];
    const inWindow = `($1 = 'all' OR created_at >= now() - $2::interval)`;

    const stats = await this.one<any>(
      `SELECT
         COUNT(*)                                    AS total,
         COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
         COUNT(*) FILTER (WHERE status = 'approved') AS approved,
         COUNT(*) FILTER (WHERE status = 'declined') AS declined,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0
         ) FILTER (WHERE status = 'approved' AND resolved_at IS NOT NULL)
                                                     AS median_accept_hours,
         COUNT(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '24 hours')
                                                     AS pending_older_24h
       FROM contact_requests
       WHERE ${inWindow}`,
      [window, interval],
    );

    const blocks = await this.one<any>(
      `SELECT
         (SELECT COUNT(*)::int FROM user_blocks)                              AS total,
         (SELECT COUNT(*)::int FROM user_blocks WHERE ${inWindow})            AS in_window`,
      [window, interval],
    );

    const topRequesters = await this.pg.query(
      `SELECT requester_id::text AS user_id,
              COUNT(*)::int AS sent,
              COUNT(*) FILTER (WHERE status = 'approved')::int AS accepted
       FROM contact_requests
       WHERE ${inWindow}
       GROUP BY requester_id
       ORDER BY sent DESC
       LIMIT 10`,
      [window, interval],
    );
    const topTargets = await this.pg.query(
      `SELECT target_id::text AS user_id,
              COUNT(*)::int AS received,
              COUNT(*) FILTER (WHERE status = 'approved')::int AS accepted
       FROM contact_requests
       WHERE ${inWindow}
       GROUP BY target_id
       ORDER BY received DESC
       LIMIT 10`,
      [window, interval],
    );

    const total = parseInt(stats?.total || '0', 10);
    const approved = parseInt(stats?.approved || '0', 10);
    const declined = parseInt(stats?.declined || '0', 10);

    return {
      window,
      generatedAt: new Date().toISOString(),
      requests: {
        total,
        pending:  parseInt(stats?.pending || '0', 10),
        approved,
        declined,
        acceptRatePct: approved + declined > 0 ? (approved / (approved + declined)) * 100 : null,
        medianTimeToAcceptHours: stats?.median_accept_hours !== null && stats?.median_accept_hours !== undefined
          ? Number(stats.median_accept_hours) : null,
        pendingOlder24h: parseInt(stats?.pending_older_24h || '0', 10),
      },
      blocks: {
        total: parseInt(blocks?.total || '0', 10),
        inWindow: parseInt(blocks?.in_window || '0', 10),
      },
      topRequesters: topRequesters.rows.map((r: any) => ({
        userId: r.user_id, sent: r.sent, accepted: r.accepted,
      })),
      topTargets: topTargets.rows.map((r: any) => ({
        userId: r.user_id, received: r.received, accepted: r.accepted,
      })),
    };
  }
}
