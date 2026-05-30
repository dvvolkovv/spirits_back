import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Detailed churn breakdown — see monitoring.functions.md §3.10.
 *
 * Goes beyond the two indicators on the Summary tab:
 * - D30 and D90 churn (signups inactive in last 14d)
 * - Paid churn 60d (payers without new payments in 60d)
 * - Dormant rate (>14d no message)
 * - Account deletions (lifetime + window)
 * - Bounce after onboarding (signup without message in 24h)
 * - Request decline rate (sparse for now)
 * - Cohort table (by signup ISO week)
 */

const DEFAULT_EXCLUDED = ['70000000000', '79030169187'];
const EXCLUDED = (process.env.FUNNEL_EXCLUDED_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const excluded = EXCLUDED.length > 0 ? EXCLUDED : DEFAULT_EXCLUDED;

export interface ChurnOverview {
  generatedAt: string;
  excludedUsers: string[];

  retention: {
    cohortD30: number;        // users signed up ≥ 30 days ago
    activeD30: number;        // …and had message_sent in last 14 days
    churnD30Pct: number | null;

    cohortD90: number;
    activeD90: number;
    churnD90Pct: number | null;

    payersCohort: number;     // users with any succeeded payment
    payersChurn60d: number;   // payers with last payment > 60 days ago
    paidChurn60Pct: number | null;

    dormantUsers: number;     // users with no message in last 14 days
  };

  deletions: {
    total: number;
    last30d: number;
  };

  bounce: {
    cohort30d: number;        // signups in last 30 days
    bouncedCount: number;     // …without message_sent within 24h
    bouncedPct: number | null;
  };

  requestQuality: {
    declined: number;
    pendingIgnored7d: number;
    blockRatePerKActive: number | null;
  };

  // Per-cohort table: last 12 ISO weeks of signups + retention pct
  cohorts: Array<{
    week: string;
    signups: number;
    retainedD7: number;
    retainedD30: number;
    retentionD7Pct: number | null;
    retentionD30Pct: number | null;
  }>;
}

@Injectable()
export class ChurnService {
  private readonly log = new Logger(ChurnService.name);
  constructor(private readonly pg: PgService) {}

  private async one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    try {
      const r = await this.pg.query(sql, params);
      return r.rows[0] || null;
    } catch (e: any) {
      this.log.error(`churn query failed: ${e.message}`);
      return null;
    }
  }

  async getOverview(): Promise<ChurnOverview> {
    // Retention (D30) — signed up ≥30d ago, no message_sent in last 14d.
    const d30 = await this.one<any>(
      `WITH cohort AS (
         SELECT internal_id AS uid
         FROM user_id
         WHERE welcome_bonus_at IS NOT NULL
           AND welcome_bonus_at < now() - interval '30 days'
           AND internal_id <> ALL($1::text[])
       ),
       active AS (
         SELECT DISTINCT user_id AS uid
         FROM events
         WHERE name = 'message_sent' AND ts >= now() - interval '14 days'
       )
       SELECT
         (SELECT COUNT(*)::int FROM cohort) AS cohort,
         (SELECT COUNT(*)::int FROM cohort c JOIN active a ON a.uid = c.uid) AS active`,
      [excluded],
    );

    const d90 = await this.one<any>(
      `WITH cohort AS (
         SELECT internal_id AS uid
         FROM user_id
         WHERE welcome_bonus_at IS NOT NULL
           AND welcome_bonus_at < now() - interval '90 days'
           AND internal_id <> ALL($1::text[])
       ),
       active AS (
         SELECT DISTINCT user_id AS uid
         FROM events
         WHERE name = 'message_sent' AND ts >= now() - interval '14 days'
       )
       SELECT
         (SELECT COUNT(*)::int FROM cohort) AS cohort,
         (SELECT COUNT(*)::int FROM cohort c JOIN active a ON a.uid = c.uid) AS active`,
      [excluded],
    );

    const paid60 = await this.one<any>(
      `WITH last_pay AS (
         SELECT user_id, MAX(completed_at) AS last_at
         FROM payments
         WHERE status = 'succeeded' AND user_id <> ALL($1::text[])
         GROUP BY user_id
       )
       SELECT
         COUNT(*)::int                                                    AS payers,
         COUNT(*) FILTER (WHERE last_at < now() - interval '60 days')::int AS churn60
       FROM last_pay`,
      [excluded],
    );

    const dormant = await this.one<any>(
      `SELECT COUNT(*)::int AS dormant
       FROM user_id u
       WHERE u.state = 'active'
         AND u.internal_id <> ALL($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM events e
           WHERE e.user_id = u.internal_id
             AND e.name = 'message_sent'
             AND e.ts >= now() - interval '14 days'
         )`,
      [excluded],
    );

    // Deletions
    const dels = await this.one<any>(
      `SELECT
         COUNT(*)::int                                                        AS total,
         COUNT(*) FILTER (WHERE update_date >= now() - interval '30 days')::int AS last30d
       FROM user_id WHERE state = 'deleted' AND internal_id <> ALL($1::text[])`,
      [excluded],
    );

    // Bounce after onboarding (signups in last 30d w/o message_sent in 24h)
    const bounce = await this.one<any>(
      `WITH cohort AS (
         SELECT internal_id AS uid, welcome_bonus_at AS signup_ts
         FROM user_id
         WHERE welcome_bonus_at IS NOT NULL
           AND welcome_bonus_at >= now() - interval '30 days'
           AND internal_id <> ALL($1::text[])
       )
       SELECT
         COUNT(*)::int AS cohort,
         COUNT(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM events e
           WHERE e.user_id = cohort.uid
             AND e.name = 'message_sent'
             AND e.ts BETWEEN cohort.signup_ts AND cohort.signup_ts + interval '24 hours'
         ))::int AS bounced
       FROM cohort`,
      [excluded],
    );

    // Request quality + blocks
    const reqQual = await this.one<any>(
      `SELECT
         (SELECT COUNT(*)::int FROM contact_requests WHERE status = 'declined')        AS declined,
         (SELECT COUNT(*)::int FROM contact_requests WHERE status = 'pending'
            AND created_at < now() - interval '7 days')                                AS pending_ignored,
         (SELECT COUNT(*)::int FROM user_blocks)                                       AS blocks_total,
         (SELECT COUNT(DISTINCT user_id)::int FROM events
            WHERE name = 'message_sent' AND ts >= now() - interval '30 days'
              AND user_id <> ALL($1::text[]))                                          AS active_30d`,
      [excluded],
    );

    const blocks = parseInt(reqQual?.blocks_total || '0', 10);
    const active30 = parseInt(reqQual?.active_30d || '0', 10);

    // Per-cohort table (last 12 ISO weeks)
    const cohorts = await this.pg.query(
      `WITH weeks AS (
         SELECT date_trunc('week', welcome_bonus_at AT TIME ZONE 'UTC')::date AS week,
                internal_id AS uid,
                welcome_bonus_at AS signup_ts
         FROM user_id
         WHERE welcome_bonus_at IS NOT NULL
           AND welcome_bonus_at >= now() - interval '12 weeks'
           AND internal_id <> ALL($1::text[])
       )
       SELECT
         w.week,
         COUNT(*)::int                                                                AS signups,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM events e
           WHERE e.user_id = w.uid AND e.name = 'message_sent'
             AND e.ts BETWEEN w.signup_ts + interval '6 days' AND w.signup_ts + interval '8 days'
         ))::int                                                                       AS retained_d7,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM events e
           WHERE e.user_id = w.uid AND e.name = 'message_sent'
             AND e.ts BETWEEN w.signup_ts + interval '29 days' AND w.signup_ts + interval '31 days'
         ))::int                                                                       AS retained_d30
       FROM weeks w
       GROUP BY w.week ORDER BY w.week DESC LIMIT 12`,
      [excluded],
    );

    const cohortD30 = parseInt(d30?.cohort || '0', 10);
    const activeD30 = parseInt(d30?.active || '0', 10);
    const cohortD90 = parseInt(d90?.cohort || '0', 10);
    const activeD90 = parseInt(d90?.active || '0', 10);
    const payers = parseInt(paid60?.payers || '0', 10);
    const churn60 = parseInt(paid60?.churn60 || '0', 10);
    const bCohort = parseInt(bounce?.cohort || '0', 10);
    const bouncedCnt = parseInt(bounce?.bounced || '0', 10);

    return {
      generatedAt: new Date().toISOString(),
      excludedUsers: excluded,
      retention: {
        cohortD30, activeD30,
        churnD30Pct: cohortD30 > 0 ? ((cohortD30 - activeD30) / cohortD30) * 100 : null,
        cohortD90, activeD90,
        churnD90Pct: cohortD90 > 0 ? ((cohortD90 - activeD90) / cohortD90) * 100 : null,
        payersCohort: payers,
        payersChurn60d: churn60,
        paidChurn60Pct: payers > 0 ? (churn60 / payers) * 100 : null,
        dormantUsers: parseInt(dormant?.dormant || '0', 10),
      },
      deletions: {
        total: parseInt(dels?.total || '0', 10),
        last30d: parseInt(dels?.last30d || '0', 10),
      },
      bounce: {
        cohort30d: bCohort,
        bouncedCount: bouncedCnt,
        bouncedPct: bCohort > 0 ? (bouncedCnt / bCohort) * 100 : null,
      },
      requestQuality: {
        declined: parseInt(reqQual?.declined || '0', 10),
        pendingIgnored7d: parseInt(reqQual?.pending_ignored || '0', 10),
        blockRatePerKActive: active30 > 0 ? (blocks / active30) * 1000 : null,
      },
      cohorts: cohorts.rows.map((r: any) => {
        const signups = parseInt(r.signups, 10);
        const rd7 = parseInt(r.retained_d7, 10);
        const rd30 = parseInt(r.retained_d30, 10);
        return {
          week: r.week instanceof Date ? r.week.toISOString().slice(0, 10) : String(r.week),
          signups,
          retainedD7: rd7,
          retainedD30: rd30,
          retentionD7Pct:  signups > 0 ? (rd7 / signups) * 100 : null,
          retentionD30Pct: signups > 0 ? (rd30 / signups) * 100 : null,
        };
      }),
    };
  }
}
