import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Economy & activation overview — see monitoring.functions.md §3.1 + §3.5.
 *
 * Data sources:
 * - `payments`         — revenue, paying users, ARPPU, repeat rate
 * - `events`           — DAU/WAU/MAU (message_sent), activation
 * - `user_id`          — signup cohorts (welcome_bonus_at)
 * - `ai_profiles_consolidated` — current token balances
 *
 * Test users (smoke + admin) are excluded everywhere (same env var as funnel).
 */

export type EconomyWindow = '24h' | '7d' | '30d' | '90d' | 'all';

const WINDOW_INTERVAL: Record<EconomyWindow, string> = {
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
  '90d': '90 days',
  // 'all' — special-cased in queries
  'all': '100 years',
};

const DEFAULT_EXCLUDED = ['70000000000', '79030169187'];
const EXCLUDED_USERS: string[] = (process.env.FUNNEL_EXCLUDED_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const excluded = EXCLUDED_USERS.length > 0 ? EXCLUDED_USERS : DEFAULT_EXCLUDED;

export interface EconomyOverview {
  window: EconomyWindow;
  generatedAt: string;
  excludedUsers: string[];

  revenue: {
    totalRub: number;
    paymentsCount: number;
    avgCheckRub: number;
  };
  paying: {
    uniquePayersWindow: number;
    uniquePayersAllTime: number;
    arppuRub: number;            // revenue in window / payers in window
    arpuRub: number;             // revenue in window / active users in window
    paidConversionPct: number;   // payers in window / signups in window * 100
    repeatRatePctAllTime: number; // % of all-time payers with 2+ payments
  };
  engagement: {
    dau: number;
    wau: number;
    mau: number;
    stickinessPct: number;
  };
  activation: {
    signupsInWindow: number;
    activatedInWindow: number;    // signups with 3+ message_sent within 24h
    activationRatePct: number;
  };
  tokens: {
    totalBalance: number;
    avgBalance: number;
  };
  dailyRevenue: Array<{ day: string; rub: number; payments: number }>;
}

@Injectable()
export class EconomyService {
  private readonly log = new Logger(EconomyService.name);

  constructor(private readonly pg: PgService) {}

  private async one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    try {
      const r = await this.pg.query(sql, params);
      return r.rows[0] || null;
    } catch (e: any) {
      this.log.error(`economy query failed: ${e.message}`);
      return null;
    }
  }

  async getOverview(window: EconomyWindow): Promise<EconomyOverview> {
    const interval = WINDOW_INTERVAL[window];

    // 1. Revenue in window
    const rev = await this.one<{ rub: string; cnt: string; avg: string }>(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS rub,
              COUNT(*)::int                       AS cnt,
              COALESCE(AVG(amount), 0)::numeric   AS avg
       FROM payments
       WHERE status = 'succeeded'
         AND user_id <> ALL($1::text[])
         AND ($2 = 'all' OR completed_at >= now() - $3::interval)`,
      [excluded, window, interval],
    );

    // 2. Paying users: in window and all-time
    const payersWindow = await this.one<{ n: string }>(
      `SELECT COUNT(DISTINCT user_id)::int AS n
       FROM payments
       WHERE status = 'succeeded'
         AND user_id <> ALL($1::text[])
         AND ($2 = 'all' OR completed_at >= now() - $3::interval)`,
      [excluded, window, interval],
    );
    const payersAll = await this.one<{ n: string }>(
      `SELECT COUNT(DISTINCT user_id)::int AS n
       FROM payments
       WHERE status = 'succeeded' AND user_id <> ALL($1::text[])`,
      [excluded],
    );

    // 3. Repeat rate (all-time): % of payers with 2+ payments
    const repeat = await this.one<{ total: string; repeat: string }>(
      `WITH c AS (
        SELECT user_id, COUNT(*) AS p
        FROM payments
        WHERE status = 'succeeded' AND user_id <> ALL($1::text[])
        GROUP BY user_id
      )
      SELECT COUNT(*)::int                      AS total,
             COUNT(*) FILTER (WHERE p >= 2)::int AS repeat
      FROM c`,
      [excluded],
    );

    // 4. Engagement: DAU/WAU/MAU based on message_sent in events.
    const eng = await this.one<{ dau: string; wau: string; mau: string }>(
      `SELECT
         COUNT(DISTINCT user_id) FILTER (WHERE ts >= now() - interval '1 day')   AS dau,
         COUNT(DISTINCT user_id) FILTER (WHERE ts >= now() - interval '7 days')  AS wau,
         COUNT(DISTINCT user_id) FILTER (WHERE ts >= now() - interval '30 days') AS mau
       FROM events
       WHERE name = 'message_sent'
         AND user_id IS NOT NULL
         AND user_id <> ALL($1::text[])`,
      [excluded],
    );

    // 5. Activation:
    //    Signups in window (from user_id.welcome_bonus_at, excludes test phones).
    //    Activated = signup users with >= 3 message_sent within 24h after signup.
    //    For users that signed up before events table existed there's no data,
    //    so this naturally counts only recent cohorts.
    const sigs = await this.one<{ signups: string; activated: string }>(
      `WITH cohort AS (
         SELECT internal_id AS user_id, welcome_bonus_at AS signup_ts
         FROM user_id
         WHERE welcome_bonus_at IS NOT NULL
           AND internal_id <> ALL($1::text[])
           AND ($2 = 'all' OR welcome_bonus_at >= now() - $3::interval)
       ),
       msgs AS (
         SELECT c.user_id
         FROM cohort c
         JOIN events e ON e.user_id = c.user_id
                       AND e.name = 'message_sent'
                       AND e.ts >= c.signup_ts
                       AND e.ts <  c.signup_ts + interval '24 hours'
         GROUP BY c.user_id
         HAVING COUNT(*) >= 3
       )
       SELECT (SELECT COUNT(*)::int FROM cohort) AS signups,
              (SELECT COUNT(*)::int FROM msgs)   AS activated`,
      [excluded, window, interval],
    );

    // 6. Token balances (all active users)
    const tok = await this.one<{ total: string; avg: string }>(
      `SELECT COALESCE(SUM(tokens), 0)::bigint   AS total,
              COALESCE(AVG(tokens), 0)::numeric AS avg
       FROM ai_profiles_consolidated p
       JOIN user_id u ON u.internal_id = p.user_id
       WHERE u.state = 'active'
         AND p.user_id <> ALL($1::text[])`,
      [excluded],
    );

    // 7. Daily revenue last 30 days for sparkline
    const daily = await this.pg.query(
      `SELECT date_trunc('day', completed_at)::date AS day,
              SUM(amount)::numeric                  AS rub,
              COUNT(*)::int                          AS payments
       FROM payments
       WHERE status = 'succeeded'
         AND completed_at >= now() - interval '30 days'
         AND user_id <> ALL($1::text[])
       GROUP BY 1 ORDER BY 1`,
      [excluded],
    );

    const revRub = parseFloat(rev?.rub || '0');
    const revCnt = parseInt(rev?.cnt || '0', 10);
    const avgCheck = parseFloat(rev?.avg || '0');
    const payersWin = parseInt(payersWindow?.n || '0', 10);
    const payersAllTime = parseInt(payersAll?.n || '0', 10);
    const repeatTotal = parseInt(repeat?.total || '0', 10);
    const repeatCnt = parseInt(repeat?.repeat || '0', 10);
    const dau = parseInt(eng?.dau || '0', 10);
    const wau = parseInt(eng?.wau || '0', 10);
    const mau = parseInt(eng?.mau || '0', 10);
    const signups = parseInt(sigs?.signups || '0', 10);
    const activated = parseInt(sigs?.activated || '0', 10);
    const tokTotal = parseInt(tok?.total || '0', 10);
    const tokAvg = parseFloat(tok?.avg || '0');

    // Active users (any message_sent in window) for ARPU denominator
    const activeRow = await this.one<{ n: string }>(
      `SELECT COUNT(DISTINCT user_id)::int AS n
       FROM events
       WHERE name = 'message_sent'
         AND user_id IS NOT NULL
         AND user_id <> ALL($1::text[])
         AND ($2 = 'all' OR ts >= now() - $3::interval)`,
      [excluded, window, interval],
    );
    const activeInWindow = parseInt(activeRow?.n || '0', 10);

    return {
      window,
      generatedAt: new Date().toISOString(),
      excludedUsers: excluded,
      revenue: {
        totalRub: revRub,
        paymentsCount: revCnt,
        avgCheckRub: avgCheck,
      },
      paying: {
        uniquePayersWindow: payersWin,
        uniquePayersAllTime: payersAllTime,
        arppuRub: payersWin > 0 ? revRub / payersWin : 0,
        arpuRub: activeInWindow > 0 ? revRub / activeInWindow : 0,
        paidConversionPct: signups > 0 ? (payersWin / signups) * 100 : 0,
        repeatRatePctAllTime: repeatTotal > 0 ? (repeatCnt / repeatTotal) * 100 : 0,
      },
      engagement: {
        dau, wau, mau,
        stickinessPct: mau > 0 ? (dau / mau) * 100 : 0,
      },
      activation: {
        signupsInWindow: signups,
        activatedInWindow: activated,
        activationRatePct: signups > 0 ? (activated / signups) * 100 : 0,
      },
      tokens: {
        totalBalance: tokTotal,
        avgBalance: Math.round(tokAvg),
      },
      dailyRevenue: daily.rows.map((r: any) => ({
        day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
        rub: parseFloat(r.rub),
        payments: parseInt(r.payments, 10),
      })),
    };
  }
}
