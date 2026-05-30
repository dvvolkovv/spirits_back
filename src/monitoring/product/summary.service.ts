import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { ProfileDepthService } from './profile-depth.service';

/**
 * Top-10 product health indicators — see monitoring.functions.md §3.11.
 *
 * Strategy: one query per indicator, all in parallel via Promise.all.
 * Each indicator emits { value, status, target, hint } so the UI can
 * render a uniform card regardless of which metric it is.
 *
 * Where data isn't yet available (e.g. TTV needs events from a fresh
 * cohort) the value comes back as null and the card shows "—".
 */

export type Status = 'good' | 'warn' | 'bad' | 'unknown';
export type Group = 'growth' | 'funnel' | 'risk' | 'infra';

export interface Indicator {
  id: string;
  group: Group;
  label: string;
  value: string;
  numeric: number | null;       // raw number, useful for sorting/colouring
  status: Status;
  target: string;
  hint?: string;
}

export interface SummaryOverview {
  generatedAt: string;
  indicators: Indicator[];
}

const DEFAULT_EXCLUDED = ['70000000000', '79030169187'];
const EXCLUDED = (process.env.FUNNEL_EXCLUDED_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const excluded = EXCLUDED.length > 0 ? EXCLUDED : DEFAULT_EXCLUDED;

@Injectable()
export class SummaryService {
  private readonly log = new Logger(SummaryService.name);

  constructor(
    private readonly pg: PgService,
    private readonly profileDepth: ProfileDepthService,
  ) {}

  private async num(sql: string, params: any[] = []): Promise<number | null> {
    try {
      const r = await this.pg.query(sql, params);
      const v = r.rows[0]?.v;
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    } catch (e: any) {
      this.log.error(`summary num query failed: ${e.message}`);
      return null;
    }
  }

  // PDS: from ProfileDepthService overview.
  private async pds(): Promise<number | null> {
    const o = await this.profileDepth.getOverview().catch(() => null);
    return o?.perUser.avgPds ?? null;
  }

  // Request Accept rate: approved / (approved + declined) all time.
  private async requestAcceptRate(): Promise<number | null> {
    return this.num(
      `SELECT
         CASE WHEN approved + declined = 0 THEN NULL
              ELSE 100.0 * approved / (approved + declined) END AS v
       FROM (
         SELECT
           COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
           COUNT(*) FILTER (WHERE status = 'declined')::int AS declined
         FROM contact_requests
       ) t`,
    );
  }

  // TTV-результат: median (signup_completed → message_sent) gap in hours,
  // last 30 days of signups.
  private async ttvMedianHours(): Promise<number | null> {
    return this.num(
      `WITH cohort AS (
         SELECT user_id AS uid, MIN(ts) AS signup_ts
         FROM events
         WHERE name = 'signup_completed'
           AND user_id IS NOT NULL
           AND user_id <> ALL($1::text[])
           AND ts >= now() - interval '30 days'
         GROUP BY user_id
       ),
       first_msg AS (
         SELECT c.uid, MIN(e.ts) AS first_msg_ts
         FROM cohort c
         JOIN events e ON e.user_id = c.uid AND e.name = 'message_sent'
           AND e.ts >= c.signup_ts
         GROUP BY c.uid
       )
       SELECT percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (first_msg.first_msg_ts - cohort.signup_ts)) / 3600.0
       ) AS v
       FROM cohort
       JOIN first_msg ON first_msg.uid = cohort.uid`,
      [excluded],
    );
  }

  // AI-share поддержки: % tickets that resolved without owner involvement.
  // Proxy: count of tickets where status NOT IN ('owner_handling') divided by total.
  // (Full version would require support_events history.)
  private async aiShareSupport(): Promise<number | null> {
    return this.num(
      `SELECT CASE WHEN COUNT(*) = 0 THEN NULL
              ELSE 100.0 * COUNT(*) FILTER (WHERE status <> 'owner_handling') / COUNT(*) END AS v
       FROM support_tickets`,
    );
  }

  // Margin per 1000 tokens: revenue (RUB) / tokens distributed via payments * 1000.
  // Both numbers from payments.succeeded — purest signal of paid-token economics.
  private async marginPer1k(): Promise<number | null> {
    return this.num(
      `SELECT CASE WHEN SUM(tokens) = 0 THEN NULL
              ELSE 1000.0 * SUM(amount) / SUM(tokens) END AS v
       FROM payments
       WHERE status = 'succeeded'
         AND user_id <> ALL($1::text[])`,
      [excluded],
    );
  }

  // Funnel: signup → first_value (proxy = first message ≥ 1).
  // Of users who signed up in last 30 days, what % had message_sent within 7 days.
  private async signupToFirstValue(): Promise<number | null> {
    return this.num(
      `WITH cohort AS (
         SELECT user_id AS uid, MIN(ts) AS signup_ts
         FROM events
         WHERE name = 'signup_completed' AND user_id IS NOT NULL
           AND user_id <> ALL($1::text[])
           AND ts >= now() - interval '30 days'
         GROUP BY user_id
       ),
       reached AS (
         SELECT DISTINCT c.uid
         FROM cohort c
         JOIN events e ON e.user_id = c.uid
              AND e.name = 'message_sent'
              AND e.ts BETWEEN c.signup_ts AND c.signup_ts + interval '7 days'
       )
       SELECT CASE WHEN (SELECT COUNT(*) FROM cohort) = 0 THEN NULL
              ELSE 100.0 * (SELECT COUNT(*) FROM reached) / (SELECT COUNT(*) FROM cohort) END AS v`,
      [excluded],
    );
  }

  // Funnel: % of payers who reached a second payment (all-time).
  private async firstToSecondPayment(): Promise<number | null> {
    return this.num(
      `WITH p AS (
         SELECT user_id, COUNT(*) AS n
         FROM payments
         WHERE status = 'succeeded' AND user_id <> ALL($1::text[])
         GROUP BY user_id
       )
       SELECT CASE WHEN COUNT(*) = 0 THEN NULL
              ELSE 100.0 * COUNT(*) FILTER (WHERE n >= 2) / COUNT(*) END AS v
       FROM p`,
      [excluded],
    );
  }

  // Churn D30: of users who signed up 30+ days ago, % with no activity in last 14 days.
  private async churnD30(): Promise<number | null> {
    return this.num(
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
         WHERE name = 'message_sent'
           AND ts >= now() - interval '14 days'
       )
       SELECT CASE WHEN (SELECT COUNT(*) FROM cohort) = 0 THEN NULL
              ELSE 100.0 * (
                (SELECT COUNT(*) FROM cohort) - (
                  SELECT COUNT(*) FROM cohort c JOIN active a ON a.uid = c.uid
                )
              ) / (SELECT COUNT(*) FROM cohort) END AS v`,
      [excluded],
    );
  }

  // Paid churn 60d: of users who had a payment 60+ days ago, % with no new payment since.
  private async paidChurn60(): Promise<number | null> {
    return this.num(
      `WITH last_pay AS (
         SELECT user_id, MAX(completed_at) AS last_at, COUNT(*) AS n
         FROM payments
         WHERE status = 'succeeded' AND user_id <> ALL($1::text[])
         GROUP BY user_id
       )
       SELECT CASE WHEN COUNT(*) = 0 THEN NULL
              ELSE 100.0 * COUNT(*) FILTER (WHERE last_at < now() - interval '60 days') / COUNT(*) END AS v
       FROM last_pay`,
      [excluded],
    );
  }

  // Feature health: % of latest-run synthetic scenarios that succeeded.
  private async featureHealth(): Promise<number | null> {
    return this.num(
      `WITH latest AS (
         SELECT DISTINCT ON (scenario) scenario, success
         FROM synthetic_runs ORDER BY scenario, ts DESC
       )
       SELECT CASE WHEN COUNT(*) = 0 THEN NULL
              ELSE 100.0 * COUNT(*) FILTER (WHERE success) / COUNT(*) END AS v
       FROM latest`,
    );
  }

  async getOverview(): Promise<SummaryOverview> {
    const [
      pds, raReq, ttv, aiShare, margin,
      sigToFv, firstToSecond,
      churnD30, paid60,
      featureHealth,
    ] = await Promise.all([
      this.pds(),
      this.requestAcceptRate(),
      this.ttvMedianHours(),
      this.aiShareSupport(),
      this.marginPer1k(),
      this.signupToFirstValue(),
      this.firstToSecondPayment(),
      this.churnD30(),
      this.paidChurn60(),
      this.featureHealth(),
    ]);

    const status = (val: number | null, good: (n: number) => boolean, warn: (n: number) => boolean): Status => {
      if (val === null) return 'unknown';
      if (good(val)) return 'good';
      if (warn(val)) return 'warn';
      return 'bad';
    };

    const fmtN = (v: number | null) => v === null ? '—' : Math.round(v).toString();
    const fmtPct = (v: number | null) => v === null ? '—' : `${v.toFixed(1)}%`;
    const fmtRub = (v: number | null) => v === null ? '—' : `${v.toFixed(2)} ₽ / 1K`;
    const fmtHours = (v: number | null) => {
      if (v === null) return '—';
      if (v < 1) return `${Math.round(v * 60)} мин`;
      if (v < 48) return `${v.toFixed(1)} ч`;
      return `${(v / 24).toFixed(1)} дн`;
    };

    const indicators: Indicator[] = [
      {
        id: 'pds', group: 'growth', label: 'Profile Depth Score (средн.)',
        value: fmtN(pds), numeric: pds,
        target: 'растёт',
        // PDS — без жёсткого порога, ориентир: чем выше, тем глубже профиль
        status: pds === null ? 'unknown' : pds > 100 ? 'good' : pds > 30 ? 'warn' : 'bad',
        hint: 'PDS = Σ entities × weight по §3.3',
      },
      {
        id: 'accept_rate', group: 'growth', label: 'Request Accept rate',
        value: fmtPct(raReq), numeric: raReq,
        target: '≥ 40%',
        status: status(raReq, (n) => n >= 40, (n) => n >= 20),
      },
      {
        id: 'ttv', group: 'growth', label: 'TTV-результат (медиана)',
        value: fmtHours(ttv), numeric: ttv,
        target: '< 24 ч',
        // меньше = лучше
        status: ttv === null ? 'unknown' : ttv < 24 ? 'good' : ttv < 48 ? 'warn' : 'bad',
        hint: 'signup → первое сообщение, 30-дн когорта',
      },
      {
        id: 'ai_share', group: 'growth', label: 'AI-share поддержки',
        value: fmtPct(aiShare), numeric: aiShare,
        target: '≥ 80%',
        status: status(aiShare, (n) => n >= 80, (n) => n >= 60),
      },
      {
        id: 'margin', group: 'growth', label: 'Цена за 1000 токенов',
        value: fmtRub(margin), numeric: margin,
        target: 'положит.',
        status: margin === null ? 'unknown' : margin > 5 ? 'good' : margin > 1 ? 'warn' : 'bad',
        hint: 'Σ выручка / Σ выданные токены × 1000',
      },
      {
        id: 'signup_to_first_value', group: 'funnel', label: 'Активация (signup → первое сообщение / 7 дн)',
        value: fmtPct(sigToFv), numeric: sigToFv,
        target: '≥ 60%',
        status: status(sigToFv, (n) => n >= 60, (n) => n >= 40),
      },
      {
        id: 'first_to_second_payment', group: 'funnel', label: 'Первая → вторая оплата',
        value: fmtPct(firstToSecond), numeric: firstToSecond,
        target: 'тренд ↑',
        status: status(firstToSecond, (n) => n >= 30, (n) => n >= 15),
      },
      {
        id: 'churn_d30', group: 'risk', label: 'Churn D30',
        value: fmtPct(churnD30), numeric: churnD30,
        target: '< 30%',
        // меньше = лучше
        status: churnD30 === null ? 'unknown' : churnD30 < 30 ? 'good' : churnD30 < 50 ? 'warn' : 'bad',
        hint: 'signup ≥ 30 дн назад, нет message_sent за 14 дней',
      },
      {
        id: 'paid_churn_60', group: 'risk', label: 'Paid churn (60 дн)',
        value: fmtPct(paid60), numeric: paid60,
        target: '< 30%',
        status: paid60 === null ? 'unknown' : paid60 < 30 ? 'good' : paid60 < 50 ? 'warn' : 'bad',
        hint: 'Платил ≥ 60 дн назад, новых платежей нет',
      },
      {
        id: 'feature_health', group: 'infra', label: 'Feature health (synthetic)',
        value: fmtPct(featureHealth), numeric: featureHealth,
        target: '= 100%',
        status: featureHealth === null ? 'unknown' : featureHealth >= 100 ? 'good' : featureHealth >= 80 ? 'warn' : 'bad',
        hint: 'Доля зелёных synthetic-сценариев',
      },
    ];

    return { generatedAt: new Date().toISOString(), indicators };
  }
}
