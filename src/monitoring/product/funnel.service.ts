import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Sales funnel — see monitoring.functions.md §3.8.
 *
 * ИСТИННАЯ воронка (f084b02a): после «Посетителя» (анонимные сессии) идёт
 * пользовательская воронка по user_id, где КАЖДЫЙ шаг — подмножество
 * предыдущего (накопительное пересечение когорт). Это гарантирует
 * монотонность «от большего к меньшему» — никаких скачков вверх.
 *
 * Из цепочки убраны SMS-only шаги (otp_request/otp_verified): при входе через
 * Google/Yandex/email они = 0, что раньше давало ложный «провал до нуля → рост».
 * Тестовый/админ-трафик исключается полностью (4 номера + паттерн 790300xxxxx),
 * иначе дев-аккаунт раздувал верх воронки.
 */

export interface FunnelStep {
  key: string;
  label: string;
  hint: string;          // i-подсказка: что и как считается на этом шаге
  count: number;
  ratioToFirst: number | null;
  ratioToPrev: number | null;
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

// Полный список тестовых/админ-номеров + паттерн — тот же, что в VPM/economy.
const TEST_USERS = ['70000000000', '79030169187', '79169403771', '79656445804'];
const TEST_PATTERN = '^790300[0-9]{5}$';
// Конфигурируемый override (через запятую). По умолчанию — полный список.
const EXCLUDED_USERS: string[] = (process.env.FUNNEL_EXCLUDED_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const effectiveExcluded = EXCLUDED_USERS.length > 0 ? EXCLUDED_USERS : TEST_USERS;

// SQL-фрагмент «не тестовый user_id»: массив (param) + паттерн (инлайн-константа).
const NOT_TEST = (col: string, arrayParam: string) =>
  `${col} <> ALL(${arrayParam}::text[]) AND ${col} !~ '${TEST_PATTERN}'`;

interface StepDef {
  key: string;
  label: string;
  hint: string;
  identity: 'session' | 'user';
  // Возвращает множество идентификаторов (session_id или user_id), достигших
  // шага ПЕРВЫЙ раз в окне.
  query: (from: string, to: string, source: string | null, excluded: string[]) => { sql: string; params: any[] };
}

@Injectable()
export class FunnelService {
  private readonly log = new Logger(FunnelService.name);

  constructor(private readonly pg: PgService) {}

  // Юзеры, впервые сделавшие атомарное событие `name` в окне.
  private userStep(name: string): StepDef['query'] {
    return (from, to, source, excluded) => ({
      sql: `
        SELECT user_id
        FROM events
        WHERE name = $1
          AND ts >= $2 AND ts < $3
          AND user_id IS NOT NULL
          AND ${NOT_TEST('user_id', '$4')}
          ${source ? 'AND source = $5' : ''}
        GROUP BY user_id`,
      params: source ? [name, from, to, excluded, source] : [name, from, to, excluded],
    });
  }

  // N-е событие `name` у юзера (window-function), напр. 2-я оплата.
  private nthUserStep(name: string, n: number): StepDef['query'] {
    return (from, to, source, excluded) => ({
      sql: `
        SELECT user_id FROM (
          SELECT user_id, ts,
                 ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts) AS rn
          FROM events
          WHERE name = $1
            AND user_id IS NOT NULL
            AND ${NOT_TEST('user_id', '$4')}
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
      hint: 'Анонимные визиты на лендинг — считаются по уникальным сессиям (session_id), ещё без входа. Это «верх воронки» и иной тип счёта, чем шаги ниже (по пользователям), поэтому процент к нему не считается.',
      identity: 'session',
      query: (from, to, source) => ({
        sql: `
          SELECT session_id
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
      key: 'auth_succeeded',
      label: 'Залогинился',
      hint: 'Пользователи, успешно вошедшие любым способом (SMS, Google, Yandex, email) впервые в окне. Это знаменатель пользовательской воронки (100%).',
      identity: 'user',
      query: this.userStep('auth_succeeded'),
    },
    {
      key: 'first_message_sent',
      label: 'Первое сообщение',
      hint: 'Из вошедших — кто отправил хотя бы одно сообщение ассистенту. Подмножество «Залогинился».',
      identity: 'user',
      query: this.userStep('message_sent'),
    },
    {
      key: 'first_response_received',
      label: 'Получил ответ',
      hint: 'Из написавших — кто получил ответ ассистента (диалог реально начался). Подмножество предыдущего.',
      identity: 'user',
      query: this.userStep('response_received'),
    },
    {
      key: 'meaningful_dialog',
      label: 'Диалог 3+ реплик',
      hint: 'Из получивших ответ — кто дошёл до 3+ сообщений в одной сессии (вовлечённость). Подмножество предыдущего.',
      identity: 'user',
      query: (from, to, source, excluded) => ({
        sql: `
          SELECT user_id FROM (
            SELECT user_id, ROW_NUMBER() OVER (PARTITION BY user_id, session_id ORDER BY ts) AS rn
            FROM events
            WHERE name = 'message_sent'
              AND ts >= $1 AND ts < $2
              AND user_id IS NOT NULL
              AND ${NOT_TEST('user_id', '$3')}
              ${source ? 'AND source = $4' : ''}
          ) t
          WHERE rn >= 3
          GROUP BY user_id`,
        params: source ? [from, to, excluded, source] : [from, to, excluded],
      }),
    },
    {
      key: 'payment_initiated',
      label: 'Инициировал платёж',
      hint: 'Из вовлечённых — кто нажал «оплатить» (создан платёж). Подмножество предыдущего.',
      identity: 'user',
      query: this.userStep('payment_initiated'),
    },
    {
      key: 'first_payment_success',
      label: 'Первая оплата',
      hint: 'Из инициировавших — кто успешно оплатил впервые. Подмножество предыдущего.',
      identity: 'user',
      query: this.userStep('payment_success'),
    },
    {
      key: 'second_payment_success',
      label: 'Вторая оплата',
      hint: 'Из оплативших — кто оплатил второй раз (повторная покупка). Подмножество предыдущего.',
      identity: 'user',
      query: this.nthUserStep('payment_success', 2),
    },
    {
      key: 'recurring_buyer',
      label: 'Постоянный плательщик (3+)',
      hint: 'Кто оплатил 3+ раза. Подмножество «Вторая оплата».',
      identity: 'user',
      query: this.nthUserStep('payment_success', 3),
    },
  ];

  async getFunnel(fromIso: string, toIso: string, source: string | null): Promise<FunnelResponse> {
    const results: FunnelStep[] = [];
    let cohort: Set<string> | null = null;   // накопительная когорта user-шагов
    let firstUserCount = 0;
    let prevUserCount: number | null = null;

    for (const step of this.steps) {
      const { sql, params } = step.query(fromIso, toIso, source, effectiveExcluded);
      let ids: string[] = [];
      try {
        const r = await this.pg.query(sql, params);
        ids = r.rows.map((row: any) => row.user_id ?? row.session_id).filter(Boolean);
      } catch (e: any) {
        this.log.error(`funnel step ${step.key} failed: ${e.message}`);
      }

      let count: number;
      let ratioToFirst: number | null = null;
      let ratioToPrev: number | null = null;

      if (step.identity === 'session') {
        // Верх воронки: отдельный тип счёта, в когорту не входит.
        count = new Set(ids).size;
      } else {
        const stepUsers = new Set(ids);
        if (cohort === null) {
          // Первый user-шаг — знаменатель.
          cohort = stepUsers;
          firstUserCount = cohort.size;
          ratioToFirst = firstUserCount > 0 ? 100 : null;
        } else {
          // Подмножество предыдущей когорты → монотонно не возрастает.
          cohort = new Set([...cohort].filter((u) => stepUsers.has(u)));
          ratioToFirst = firstUserCount > 0 ? (cohort.size / firstUserCount) * 100 : null;
          ratioToPrev = prevUserCount && prevUserCount > 0 ? (cohort.size / prevUserCount) * 100 : null;
        }
        count = cohort.size;
        prevUserCount = count;
      }

      results.push({
        key: step.key,
        label: step.label,
        hint: step.hint,
        count,
        ratioToFirst,
        ratioToPrev,
        identity: step.identity,
      });
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
