import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Support metrics — see monitoring.functions.md §3.6.
 *
 * Pulled directly from the support_tickets / support_events /
 * support_messages tables. AI-share approximation: % of tickets that
 * never had an 'escalate' event (= owner never had to step in).
 */

export type SupportWindow = '24h' | '7d' | '30d' | '90d' | 'all';

const WINDOW_INTERVAL: Record<SupportWindow, string> = {
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
  '90d': '90 days',
  'all': '100 years',
};

export interface SupportOverview {
  window: SupportWindow;
  generatedAt: string;

  totals: {
    tickets: number;
    escalated: number;
    closed: number;
    resolved: number;
    refunds: number;
  };
  shareAiPct: number | null;            // tickets never escalated / total
  ttfrAiMedianMinutes: number | null;   // user → first AI reply
  ttfrOwnerMedianMinutes: number | null;// escalate → first owner reply
  ttrMedianHours: number | null;        // created → resolved/closed
  urgencyDistribution: Array<{ urgency: string; count: number }>;
  byStatus: Array<{ status: string; count: number }>;
}

@Injectable()
export class SupportService {
  private readonly log = new Logger(SupportService.name);
  constructor(private readonly pg: PgService) {}

  private async one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    try {
      const r = await this.pg.query(sql, params);
      return r.rows[0] || null;
    } catch (e: any) {
      this.log.error(`support query failed: ${e.message}`);
      return null;
    }
  }

  async getOverview(window: SupportWindow): Promise<SupportOverview> {
    const interval = WINDOW_INTERVAL[window];
    const inWindow = `($1 = 'all' OR created_at >= now() - $2::interval)`;

    const totals = await this.one<any>(
      `WITH t AS (
         SELECT * FROM support_tickets WHERE ${inWindow}
       )
       SELECT
         COUNT(*)::int                                                                  AS tickets,
         COUNT(*) FILTER (WHERE id IN (SELECT ticket_id FROM support_events WHERE action='escalate'))::int AS escalated,
         COUNT(*) FILTER (WHERE status='closed')::int                                   AS closed,
         COUNT(*) FILTER (WHERE status='resolved')::int                                 AS resolved,
         (SELECT COUNT(*)::int FROM support_events e
            WHERE e.action='refund'
              AND e.ticket_id IN (SELECT id FROM t))                                    AS refunds
       FROM t`,
      [window, interval],
    );

    // AI-share: % of tickets never escalated.
    const aiShare = await this.one<any>(
      `WITH t AS (
         SELECT * FROM support_tickets WHERE ${inWindow}
       )
       SELECT CASE WHEN COUNT(*) = 0 THEN NULL
              ELSE 100.0 * COUNT(*) FILTER (
                WHERE id NOT IN (SELECT ticket_id FROM support_events WHERE action='escalate')
              ) / COUNT(*) END AS v
       FROM t`,
      [window, interval],
    );

    // TTFR-AI: median minutes from ticket creation to first AI message.
    const ttfrAi = await this.one<any>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (m.created_at - t.created_at)) / 60.0
       ) AS v
       FROM support_tickets t
       JOIN LATERAL (
         SELECT MIN(created_at) AS created_at FROM support_messages
         WHERE ticket_id = t.id AND sender_type = 'ai'
       ) m ON true
       WHERE ${inWindow} AND m.created_at IS NOT NULL`,
      [window, interval],
    );

    // TTFR-owner: median minutes from escalate event to first owner reply.
    const ttfrOwner = await this.one<any>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (m.created_at - e.created_at)) / 60.0
       ) AS v
       FROM support_tickets t
       JOIN support_events e ON e.ticket_id = t.id AND e.action='escalate'
       JOIN LATERAL (
         SELECT MIN(created_at) AS created_at FROM support_messages
         WHERE ticket_id = t.id AND sender_type='owner' AND created_at > e.created_at
       ) m ON true
       WHERE ${inWindow} AND m.created_at IS NOT NULL`,
      [window, interval],
    );

    // TTR median hours.
    const ttr = await this.one<any>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0
       ) AS v
       FROM support_tickets
       WHERE resolved_at IS NOT NULL AND ${inWindow}`,
      [window, interval],
    );

    const urgRows = await this.pg.query(
      `SELECT COALESCE(urgency, '—') AS urgency, COUNT(*)::int AS count
       FROM support_tickets WHERE ${inWindow}
       GROUP BY 1 ORDER BY count DESC`,
      [window, interval],
    );
    const statusRows = await this.pg.query(
      `SELECT status, COUNT(*)::int AS count
       FROM support_tickets WHERE ${inWindow}
       GROUP BY 1 ORDER BY count DESC`,
      [window, interval],
    );

    return {
      window,
      generatedAt: new Date().toISOString(),
      totals: {
        tickets: parseInt(totals?.tickets || '0', 10),
        escalated: parseInt(totals?.escalated || '0', 10),
        closed: parseInt(totals?.closed || '0', 10),
        resolved: parseInt(totals?.resolved || '0', 10),
        refunds: parseInt(totals?.refunds || '0', 10),
      },
      shareAiPct: aiShare?.v !== null && aiShare?.v !== undefined ? Number(aiShare.v) : null,
      ttfrAiMedianMinutes: ttfrAi?.v !== null && ttfrAi?.v !== undefined ? Number(ttfrAi.v) : null,
      ttfrOwnerMedianMinutes: ttfrOwner?.v !== null && ttfrOwner?.v !== undefined ? Number(ttfrOwner.v) : null,
      ttrMedianHours: ttr?.v !== null && ttr?.v !== undefined ? Number(ttr.v) : null,
      urgencyDistribution: urgRows.rows.map((r: any) => ({ urgency: r.urgency, count: r.count })),
      byStatus: statusRows.rows.map((r: any) => ({ status: r.status, count: r.count })),
    };
  }
}
