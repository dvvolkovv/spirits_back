import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Sales funnel — see monitoring.functions.md §3.8.
 *
 * Atomic events are emitted by the app (otp_request, signup_completed,
 * message_sent, payment_success, etc). "First-N-th" steps are derived in SQL
 * via MIN/window-function over per-user event timestamps. Anonymous landing
 * is counted by distinct session_id where user_id IS NULL.
 *
 * Time-window semantics: a step "happened in [from, to]" means the user
 * reached that step for the first time within the window. This keeps
 * conversion ratios honest across cohorts.
 */

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  ratioToFirst: number;     // % of step 1 that reached this step
  ratioToPrev: number | null; // % conversion from prev step
}

export interface FunnelResponse {
  from: string;
  to: string;
  source: string | null;
  steps: FunnelStep[];
  generatedAt: string;
}

interface StepDef {
  key: string;
  label: string;
  // Returns: SELECT user_id, MIN(ts) AS first_ts FROM ... — keyed by user_id
  // (or session_id for the anonymous landing step).
  query: (from: string, to: string, source: string | null) => { sql: string; params: any[] };
  // For anonymous steps that have no user_id (landing); they count distinct sessions.
  identityColumn?: 'user_id' | 'session_id';
}

@Injectable()
export class FunnelService {
  private readonly log = new Logger(FunnelService.name);

  constructor(private readonly pg: PgService) {}

  private steps: StepDef[] = [
    {
      key: 'landing_view',
      label: 'Посетитель',
      identityColumn: 'session_id',
      query: (from, to, source) => ({
        sql: `
          SELECT session_id AS identity, MIN(ts) AS first_ts
          FROM events
          WHERE name = 'landing_view'
            AND ts >= $1 AND ts < $2
            AND session_id IS NOT NULL
            ${source ? 'AND source = $3' : ''}
          GROUP BY session_id`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    {
      key: 'otp_request',
      label: 'Запросил SMS-код',
      query: (from, to, source) => ({
        sql: `
          SELECT user_id AS identity, MIN(ts) AS first_ts
          FROM events
          WHERE name = 'otp_request'
            AND ts >= $1 AND ts < $2
            AND user_id IS NOT NULL
            ${source ? 'AND source = $3' : ''}
          GROUP BY user_id`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    {
      key: 'otp_verified',
      label: 'Ввёл код',
      query: (from, to, source) => ({
        sql: `
          SELECT user_id AS identity, MIN(ts) AS first_ts
          FROM events
          WHERE name = 'otp_verified'
            AND ts >= $1 AND ts < $2
            AND user_id IS NOT NULL
            ${source ? 'AND source = $3' : ''}
          GROUP BY user_id`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    {
      key: 'signup_completed',
      label: 'Зарегистрирован',
      query: (from, to, source) => ({
        sql: `
          SELECT user_id AS identity, MIN(ts) AS first_ts
          FROM events
          WHERE name = 'signup_completed'
            AND ts >= $1 AND ts < $2
            AND user_id IS NOT NULL
            ${source ? 'AND source = $3' : ''}
          GROUP BY user_id`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    {
      key: 'first_message_sent',
      label: 'Первое сообщение',
      query: (from, to, source) => ({
        sql: `
          SELECT user_id AS identity, MIN(ts) AS first_ts
          FROM events
          WHERE name = 'message_sent'
            AND ts >= $1 AND ts < $2
            AND user_id IS NOT NULL
            ${source ? 'AND source = $3' : ''}
          GROUP BY user_id`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    {
      key: 'first_response_received',
      label: 'Получил ответ',
      query: (from, to, source) => ({
        sql: `
          SELECT user_id AS identity, MIN(ts) AS first_ts
          FROM events
          WHERE name = 'response_received'
            AND ts >= $1 AND ts < $2
            AND user_id IS NOT NULL
            ${source ? 'AND source = $3' : ''}
          GROUP BY user_id`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    {
      key: 'meaningful_dialog',
      label: 'Диалог 3+ реплик',
      query: (from, to, source) => ({
        sql: `
          SELECT user_id AS identity, MIN(third_msg_ts) AS first_ts
          FROM (
            SELECT user_id, ts AS third_msg_ts,
                   ROW_NUMBER() OVER (PARTITION BY user_id, session_id ORDER BY ts) AS rn
            FROM events
            WHERE name = 'message_sent'
              AND ts >= $1 AND ts < $2
              AND user_id IS NOT NULL
              ${source ? 'AND source = $3' : ''}
          ) t
          WHERE rn = 3
          GROUP BY user_id`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    {
      key: 'payment_initiated',
      label: 'Инициировал платёж',
      query: (from, to, source) => ({
        sql: `
          SELECT user_id AS identity, MIN(ts) AS first_ts
          FROM events
          WHERE name = 'payment_initiated'
            AND ts >= $1 AND ts < $2
            AND user_id IS NOT NULL
            ${source ? 'AND source = $3' : ''}
          GROUP BY user_id`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    {
      key: 'first_payment_success',
      label: 'Первая оплата',
      query: (from, to, source) => ({
        sql: `
          SELECT user_id AS identity, MIN(ts) AS first_ts
          FROM events
          WHERE name = 'payment_success'
            AND ts >= $1 AND ts < $2
            AND user_id IS NOT NULL
            ${source ? 'AND source = $3' : ''}
          GROUP BY user_id`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    {
      key: 'second_payment_success',
      label: 'Вторая оплата',
      query: (from, to, source) => ({
        sql: `
          SELECT user_id AS identity, ts AS first_ts FROM (
            SELECT user_id, ts,
                   ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts) AS rn
            FROM events
            WHERE name = 'payment_success'
              AND user_id IS NOT NULL
              ${source ? 'AND source = $3' : ''}
          ) t
          WHERE rn = 2 AND ts >= $1 AND ts < $2`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    {
      key: 'recurring_buyer',
      label: 'Постоянный плательщик (3+)',
      query: (from, to, source) => ({
        sql: `
          SELECT user_id AS identity, ts AS first_ts FROM (
            SELECT user_id, ts,
                   ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts) AS rn
            FROM events
            WHERE name = 'payment_success'
              AND user_id IS NOT NULL
              ${source ? 'AND source = $3' : ''}
          ) t
          WHERE rn = 3 AND ts >= $1 AND ts < $2`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
  ];

  async getFunnel(fromIso: string, toIso: string, source: string | null): Promise<FunnelResponse> {
    const results: FunnelStep[] = [];
    let firstCount = 0;
    let prevCount = 0;

    for (const step of this.steps) {
      const { sql, params } = step.query(fromIso, toIso, source);
      let count = 0;
      try {
        const r = await this.pg.query(sql, params);
        count = r.rows.length;
      } catch (e: any) {
        this.log.error(`funnel step ${step.key} failed: ${e.message}`);
      }
      if (results.length === 0) firstCount = count;
      results.push({
        key: step.key,
        label: step.label,
        count,
        ratioToFirst: firstCount > 0 ? (count / firstCount) * 100 : 0,
        ratioToPrev: results.length === 0 ? null : prevCount > 0 ? (count / prevCount) * 100 : 0,
      });
      prevCount = count;
    }

    return {
      from: fromIso,
      to: toIso,
      source,
      steps: results,
      generatedAt: new Date().toISOString(),
    };
  }
}
