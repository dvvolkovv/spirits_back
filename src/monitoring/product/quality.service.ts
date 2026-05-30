import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Quality of assistant responses — see monitoring.functions.md §3.2.
 *
 * Computes per-assistant metrics from events:
 * - message volume, distinct users
 * - response latency p50/p95
 * - response failure rate
 * - average messages per session (engagement)
 * - one-and-done session share (sessions with only 1 message)
 *
 * assistant_id is extracted from event props; display name resolved via
 * the agents table.
 */

export type QualityWindow = '24h' | '7d' | '30d' | 'all';

const WINDOW_INTERVAL: Record<QualityWindow, string> = {
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
  'all': '100 years',
};

const DEFAULT_EXCLUDED = ['70000000000', '79030169187'];
const EXCLUDED_USERS = (process.env.FUNNEL_EXCLUDED_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const excluded = EXCLUDED_USERS.length > 0 ? EXCLUDED_USERS : DEFAULT_EXCLUDED;

export interface AssistantQuality {
  assistantId: string;
  assistantName: string;
  displayName: string | null;
  category: string | null;
  messages: number;
  uniqueUsers: number;
  avgRespMs: number | null;
  p95RespMs: number | null;
  failures: number;
  failureRatePct: number;
  avgPerSession: number | null;
}

export interface QualityOverview {
  window: QualityWindow;
  generatedAt: string;
  excludedUsers: string[];

  totalMessages: number;
  totalUsers: number;
  oneAndDoneSessionPct: number | null;
  globalP95RespMs: number | null;
  globalFailureRatePct: number;

  perAssistant: AssistantQuality[];
}

@Injectable()
export class QualityService {
  private readonly log = new Logger(QualityService.name);

  constructor(private readonly pg: PgService) {}

  async getOverview(window: QualityWindow): Promise<QualityOverview> {
    const interval = WINDOW_INTERVAL[window];
    const tsFilter = `($1 = 'all' OR ts >= now() - $2::interval)`;

    // Per-assistant volume from message_sent
    const perAssistantSql = `
      WITH msgs AS (
        SELECT
          (props->>'assistant_id') AS aid,
          user_id,
          session_id
        FROM events
        WHERE name = 'message_sent'
          AND user_id IS NOT NULL
          AND user_id <> ALL($3::text[])
          AND ${tsFilter}
      ),
      resp AS (
        SELECT
          (props->>'assistant_id') AS aid,
          ((props->>'duration_ms')::numeric) AS dur
        FROM events
        WHERE name = 'response_received'
          AND user_id <> ALL($3::text[])
          AND ${tsFilter}
      ),
      fail AS (
        SELECT (props->>'assistant_id') AS aid, count(*) AS n
        FROM events
        WHERE name = 'response_failed'
          AND user_id <> ALL($3::text[])
          AND ${tsFilter}
        GROUP BY 1
      )
      SELECT
        m.aid                                                  AS aid,
        a.name                                                 AS name,
        a.display_name                                         AS display_name,
        a.category                                             AS category,
        COUNT(*)::int                                          AS messages,
        COUNT(DISTINCT m.user_id)::int                         AS unique_users,
        (
          SELECT AVG(dur)::int FROM resp r WHERE r.aid = m.aid
        ) AS avg_resp_ms,
        (
          SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY dur)
          FROM resp r WHERE r.aid = m.aid
        ) AS p95_resp_ms,
        COALESCE((SELECT n FROM fail f WHERE f.aid = m.aid), 0)::int AS failures
      FROM msgs m
      LEFT JOIN agents a ON a.id::text = m.aid OR a.name = m.aid
      GROUP BY m.aid, a.name, a.display_name, a.category
      ORDER BY messages DESC
    `;

    let perRows: any[] = [];
    try {
      const r = await this.pg.query(perAssistantSql, [window, interval, excluded]);
      perRows = r.rows;
    } catch (e: any) {
      this.log.error(`per-assistant query failed: ${e.message}`);
    }

    // Avg messages per session per assistant — separate query to avoid heavy aggregation.
    const avgSessionSql = `
      WITH per_sess AS (
        SELECT
          (props->>'assistant_id') AS aid,
          session_id,
          COUNT(*) AS n
        FROM events
        WHERE name = 'message_sent'
          AND user_id IS NOT NULL
          AND session_id IS NOT NULL
          AND user_id <> ALL($3::text[])
          AND ${tsFilter}
        GROUP BY 1, 2
      )
      SELECT aid, AVG(n)::numeric(10,2) AS avg_per_session
      FROM per_sess GROUP BY 1
    `;
    let sessRows: any[] = [];
    try {
      const r = await this.pg.query(avgSessionSql, [window, interval, excluded]);
      sessRows = r.rows;
    } catch {}
    const sessByAid = new Map<string, number>();
    for (const r of sessRows) sessByAid.set(r.aid, parseFloat(r.avg_per_session));

    const perAssistant: AssistantQuality[] = perRows.map((r: any) => {
      const messages = r.messages || 0;
      const failures = r.failures || 0;
      return {
        assistantId: r.aid,
        assistantName: r.name || r.aid,
        displayName: r.display_name || null,
        category: r.category || null,
        messages,
        uniqueUsers: r.unique_users || 0,
        avgRespMs: r.avg_resp_ms !== null && r.avg_resp_ms !== undefined ? Number(r.avg_resp_ms) : null,
        p95RespMs: r.p95_resp_ms !== null && r.p95_resp_ms !== undefined ? Math.round(Number(r.p95_resp_ms)) : null,
        failures,
        failureRatePct: messages > 0 ? (failures / messages) * 100 : 0,
        avgPerSession: sessByAid.get(r.aid) ?? null,
      };
    });

    // Totals
    const totals = await this.pg.query(
      `SELECT
         COUNT(*) FILTER (WHERE name = 'message_sent')::int        AS messages,
         COUNT(DISTINCT user_id) FILTER (WHERE name = 'message_sent')::int AS users,
         COUNT(*) FILTER (WHERE name = 'response_failed')::int     AS failures
       FROM events
       WHERE user_id IS NOT NULL
         AND user_id <> ALL($3::text[])
         AND ${tsFilter}`,
      [window, interval, excluded],
    );
    const totalMessages = totals.rows[0].messages;
    const totalUsers = totals.rows[0].users;
    const totalFailures = totals.rows[0].failures;

    // One-and-done sessions: session_id with COUNT(message_sent) = 1.
    const oneAndDone = await this.pg.query(
      `WITH s AS (
         SELECT session_id, COUNT(*) AS n FROM events
         WHERE name = 'message_sent' AND session_id IS NOT NULL
           AND user_id <> ALL($3::text[])
           AND ${tsFilter}
         GROUP BY 1
       )
       SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n = 1)::int AS once
       FROM s`,
      [window, interval, excluded],
    );
    const sessTotal = oneAndDone.rows[0].total;
    const sessOnce = oneAndDone.rows[0].once;

    // Global p95 latency
    const p95 = await this.pg.query(
      `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY (props->>'duration_ms')::numeric)::int AS p95
       FROM events
       WHERE name = 'response_received'
         AND user_id <> ALL($3::text[])
         AND ${tsFilter}`,
      [window, interval, excluded],
    );

    return {
      window,
      generatedAt: new Date().toISOString(),
      excludedUsers: excluded,
      totalMessages,
      totalUsers,
      oneAndDoneSessionPct: sessTotal > 0 ? (sessOnce / sessTotal) * 100 : null,
      globalP95RespMs: p95.rows[0]?.p95 ? Math.round(Number(p95.rows[0].p95)) : null,
      globalFailureRatePct: totalMessages > 0 ? (totalFailures / totalMessages) * 100 : 0,
      perAssistant,
    };
  }
}
