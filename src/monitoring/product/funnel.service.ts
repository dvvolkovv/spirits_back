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
  // % of step 1 that reached this step. null where identity type changes
  // between steps (session_id → user_id) — comparing those would mix units.
  ratioToFirst: number | null;
  // % conversion from prev step. null on first step, on identity-type
  // change, or when the previous step had 0 entries (avoid div/0 nonsense).
  ratioToPrev: number | null;
  // 'session' = anonymous (counted by distinct session_id),
  // 'user'    = identified user (counted by distinct user_id).
  identity: 'session' | 'user';
}

export interface FunnelResponse {
  from: string;
  to: string;
  source: string | null;
  excludedUsers: string[];
  steps: FunnelStep[];
  generatedAt: string;
}

interface StepDef {
  key: string;
  label: string;
  identity: 'session' | 'user';
  query: (
    from: string,
    to: string,
    source: string | null,
    excludedUsers: string[],
  ) => { sql: string; params: any[] };
}

// Smoke tests + the admin keep firing the same atomic events under fixed
// phone numbers — they would otherwise look like real funnel traffic.
// Override via FUNNEL_EXCLUDED_USERS (comma-separated phones).
const DEFAULT_EXCLUDED_USERS = ['70000000000', '79030169187'];
const EXCLUDED_USERS: string[] =
  (process.env.FUNNEL_EXCLUDED_USERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) || [];
const effectiveExcluded = EXCLUDED_USERS.length > 0 ? EXCLUDED_USERS : DEFAULT_EXCLUDED_USERS;

@Injectable()
export class FunnelService {
  private readonly log = new Logger(FunnelService.name);

  constructor(private readonly pg: PgService) {}

  // Per-user simple step: distinct user_id who fired this atomic event
  // in window, excluding test/admin users.
  private userStep(name: string): StepDef['query'] {
    return (from, to, source, excluded) => ({
      sql: `
        SELECT user_id, MIN(ts) AS first_ts
        FROM events
        WHERE name = $1
          AND ts >= $2 AND ts < $3
          AND user_id IS NOT NULL
          AND user_id <> ALL($4::text[])
          ${source ? 'AND source = $5' : ''}
        GROUP BY user_id`,
      params: source ? [name, from, to, excluded, source] : [name, from, to, excluded],
    });
  }

  // N-th occurrence per user (window-function), e.g. 2nd payment_success.
  private nthUserStep(name: string, n: number): StepDef['query'] {
    return (from, to, source, excluded) => ({
      sql: `
        SELECT user_id, ts FROM (
          SELECT user_id, ts,
                 ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts) AS rn
          FROM events
          WHERE name = $1
            AND user_id IS NOT NULL
            AND user_id <> ALL($4::text[])
            ${source ? 'AND source = $5' : ''}
        ) t
        WHERE rn = $6 AND ts >= $2 AND ts < $3`,
      params: source ? [name, from, to, excluded, source, n] : [name, from, to, excluded, n],
    });
  }

  private steps: StepDef[] = [
    {
      key: 'landing_view',
      label: 'Посетитель',
      identity: 'session',
      query: (from, to, source) => ({
        sql: `
          SELECT session_id, MIN(ts) AS first_ts
          FROM events
          WHERE name = 'landing_view'
            AND ts >= $1 AND ts < $2
            AND session_id IS NOT NULL
            ${source ? 'AND source = $3' : ''}
          GROUP BY session_id`,
        params: source ? [from, to, source] : [from, to],
      }),
    },
    { key: 'otp_request',             label: 'Запросил SMS-код',          identity: 'user', query: this.userStep('otp_request') },
    { key: 'otp_verified',            label: 'Ввёл код',                  identity: 'user', query: this.userStep('otp_verified') },
    { key: 'signup_completed',        label: 'Зарегистрирован',           identity: 'user', query: this.userStep('signup_completed') },
    { key: 'first_message_sent',      label: 'Первое сообщение',          identity: 'user', query: this.userStep('message_sent') },
    { key: 'first_response_received', label: 'Получил ответ',             identity: 'user', query: this.userStep('response_received') },
    {
      key: 'meaningful_dialog',
      label: 'Диалог 3+ реплик',
      identity: 'user',
      query: (from, to, source, excluded) => ({
        sql: `
          SELECT user_id, MIN(third_msg_ts) AS first_ts FROM (
            SELECT user_id, ts AS third_msg_ts,
                   ROW_NUMBER() OVER (PARTITION BY user_id, session_id ORDER BY ts) AS rn
            FROM events
            WHERE name = 'message_sent'
              AND ts >= $1 AND ts < $2
              AND user_id IS NOT NULL
              AND user_id <> ALL($3::text[])
              ${source ? 'AND source = $4' : ''}
          ) t
          WHERE rn >= 3
          GROUP BY user_id`,
        params: source ? [from, to, excluded, source] : [from, to, excluded],
      }),
    },
    { key: 'payment_initiated',      label: 'Инициировал платёж',          identity: 'user', query: this.userStep('payment_initiated') },
    { key: 'first_payment_success',  label: 'Первая оплата',               identity: 'user', query: this.userStep('payment_success') },
    { key: 'second_payment_success', label: 'Вторая оплата',               identity: 'user', query: this.nthUserStep('payment_success', 2) },
    { key: 'recurring_buyer',        label: 'Постоянный плательщик (3+)',  identity: 'user', query: this.nthUserStep('payment_success', 3) },
  ];

  async getFunnel(fromIso: string, toIso: string, source: string | null): Promise<FunnelResponse> {
    const results: FunnelStep[] = [];
    let firstUserCount = 0;
    let prev: FunnelStep | null = null;

    for (const step of this.steps) {
      const { sql, params } = step.query(fromIso, toIso, source, effectiveExcluded);
      let count = 0;
      try {
        const r = await this.pg.query(sql, params);
        count = r.rowCount ?? r.rows.length;
      } catch (e: any) {
        this.log.error(`funnel step ${step.key} failed: ${e.message}`);
      }

      // ratioToFirst is meaningful only between user-keyed steps; the very
      // first user-keyed step becomes the new denominator (visitor → user
      // is an identity-type change we don't compute as a number).
      const isFirstUser = step.identity === 'user' && firstUserCount === 0;
      if (isFirstUser) firstUserCount = count;

      let ratioToFirst: number | null = null;
      if (step.identity === 'user' && firstUserCount > 0 && !isFirstUser) {
        ratioToFirst = (count / firstUserCount) * 100;
      } else if (isFirstUser && firstUserCount > 0) {
        ratioToFirst = 100;
      }

      let ratioToPrev: number | null = null;
      if (prev && prev.identity === step.identity && prev.count > 0) {
        ratioToPrev = (count / prev.count) * 100;
      }

      const stepRow: FunnelStep = {
        key: step.key,
        label: step.label,
        count,
        ratioToFirst,
        ratioToPrev,
        identity: step.identity,
      };
      results.push(stepRow);
      prev = stepRow;
    }

    return {
      from: fromIso,
      to: toIso,
      source,
      excludedUsers: effectiveExcluded,
      steps: results,
      generatedAt: new Date().toISOString(),
    };
  }
}
