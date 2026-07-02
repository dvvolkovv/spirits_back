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

  // Шаг «первое сообщение/ответ»: атомарное событие ИЛИ реальная строка в
  // custom_chat_history (server-side истина). Закрывает дыру трекинга — до
  // появления событий message_sent/response_received (~2026-06) юзеры получали
  // ответы, но события не писались → воронка их теряла. В истории нет source,
  // поэтому при ВЫБРАННОМ source остаёмся на событийном пути (как раньше);
  // без source (общая воронка) — объединяем с историей. excludeStubs убирает
  // заглушки-ошибки ("Ответ не пришёл"/"Ошибка запуска") из счёта ai-ответов.
  private chatBackedStep(eventName: string, senderType: 'human' | 'ai', excludeStubs: boolean): StepDef['query'] {
    return (from, to, source, excluded) => {
      if (source) return this.userStep(eventName)(from, to, source, excluded);
      const stubFilter = excludeStubs
        ? `AND content NOT ILIKE '%Ответ не пришёл%' AND content NOT ILIKE 'Ошибка запуска%'`
        : '';
      return {
        sql: `
          SELECT user_id FROM (
            SELECT user_id FROM events
              WHERE name = $1 AND ts >= $2 AND ts < $3 AND user_id IS NOT NULL
                AND ${NOT_TEST('user_id', '$4')}
            UNION
            SELECT split_part(session_id, '_', 1) AS user_id FROM custom_chat_history
              WHERE sender_type = $5 AND created_at >= $2 AND created_at < $3 ${stubFilter}
                AND ${NOT_TEST("split_part(session_id, '_', 1)", '$4')}
          ) u
          WHERE user_id IS NOT NULL AND user_id <> ''
          GROUP BY user_id`,
        params: [eventName, from, to, excluded, senderType],
      };
    };
  }

  // Шаг верха воронки по уникальным СЕССИЯМ (анонимный трафик до входа).
  private sessionStep(name: string): StepDef['query'] {
    return (from, to, source) => ({
      sql: `
        SELECT session_id
        FROM events
        WHERE name = $1
          AND ts >= $2 AND ts < $3
          AND session_id IS NOT NULL
          ${source ? 'AND source = $4' : ''}
        GROUP BY session_id`,
      params: source ? [name, from, to, source] : [name, from, to],
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

  // ── Платёжные шаги берём из таблицы payments (источник истины, совпадает с
  // разделом «Платежи»), а НЕ из событий payment_success: события эмитятся
  // ненадёжно (часть исторических оплат и путей подтверждения их не писала),
  // из-за чего «Вторая оплата» показывала 0 при реальных повторных оплатах.
  // source-фильтр — через signup_source профиля (у payments своей метки нет).
  private paymentInWindow(succeededOnly: boolean): StepDef['query'] {
    return (from, to, source, excluded) => {
      const dateCol = succeededOnly ? 'COALESCE(completed_at, created_at)' : 'created_at';
      const statusCond = succeededOnly ? `status = 'succeeded'` : 'TRUE';
      const srcCond = source
        ? `AND user_id IN (SELECT user_id FROM ai_profiles_consolidated WHERE signup_source = $4)`
        : '';
      return {
        sql: `
          SELECT user_id FROM payments
          WHERE ${statusCond} AND user_id IS NOT NULL
            AND ${NOT_TEST('user_id', '$3')}
            AND ${dateCol} >= $1 AND ${dateCol} < $2
            ${srcCond}
          GROUP BY user_id`,
        params: source ? [from, to, excluded, source] : [from, to, excluded],
      };
    };
  }

  // N-я УСПЕШНАЯ оплата пользователя (по payments), попавшая в окно.
  private nthPaymentStep(n: number): StepDef['query'] {
    return (from, to, source, excluded) => {
      const srcCond = source
        ? `AND user_id IN (SELECT user_id FROM ai_profiles_consolidated WHERE signup_source = $4)`
        : '';
      const nParam = source ? '$5' : '$4';
      return {
        sql: `
          SELECT user_id FROM (
            SELECT user_id, COALESCE(completed_at, created_at) AS ts,
                   ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COALESCE(completed_at, created_at)) AS rn
            FROM payments
            WHERE status = 'succeeded' AND user_id IS NOT NULL
              AND ${NOT_TEST('user_id', '$3')}
              ${srcCond}
          ) t
          WHERE rn = ${nParam} AND ts >= $1 AND ts < $2`,
        params: source ? [from, to, excluded, source, n] : [from, to, excluded, n],
      };
    };
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
      key: 'landing_cta_click',
      label: 'Нажал «Начать»',
      hint: 'Сессии, кликнувшие CTA на лендинге (по session_id). Верх воронки — счёт по сессиям, поэтому процент к предыдущему не считается. Трекинг кликов с 2026-06-14.',
      identity: 'session',
      query: this.sessionStep('landing_cta_click'),
    },
    {
      key: 'app_page_hit',
      label: 'Дошёл до приложения',
      hint: 'Сессии, доехавшие до страницы приложения (ранний маяк — ловит даже отвал на загрузке JS). Счёт по сессиям приложения. Только рекламный трафик (utm/ref/seg).',
      identity: 'session',
      query: this.sessionStep('app_page_hit'),
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
      query: this.chatBackedStep('message_sent', 'human', false),
    },
    {
      key: 'first_response_received',
      label: 'Получил ответ',
      hint: 'Из написавших — кто получил ответ ассистента (диалог реально начался). Подмножество предыдущего.',
      identity: 'user',
      query: this.chatBackedStep('response_received', 'ai', true),
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
      hint: 'Из вовлечённых — кто создал платёж (по таблице payments, любой статус). Подмножество предыдущего.',
      identity: 'user',
      query: this.paymentInWindow(false),
    },
    {
      key: 'first_payment_success',
      label: 'Первая оплата',
      hint: 'Из инициировавших — кто успешно оплатил (по таблице payments, status=succeeded). Подмножество предыдущего.',
      identity: 'user',
      query: this.paymentInWindow(true),
    },
    {
      key: 'second_payment_success',
      label: 'Вторая оплата',
      hint: 'Из оплативших — кто оплатил второй раз (2-я успешная оплата по таблице payments). Подмножество предыдущего.',
      identity: 'user',
      query: this.nthPaymentStep(2),
    },
    {
      key: 'recurring_buyer',
      label: 'Постоянный плательщик (3+)',
      hint: 'Кто оплатил 3+ раза (3-я успешная оплата по таблице payments). Подмножество «Вторая оплата».',
      identity: 'user',
      query: this.nthPaymentStep(3),
    },
  ];

  async getFunnel(fromIso: string, toIso: string, source: string | null): Promise<FunnelResponse> {
    // 1. Сырые множества идентификаторов по каждому шагу (юзеры/сессии).
    const raw: Array<{ step: StepDef; ids: Set<string> }> = [];
    for (const step of this.steps) {
      const { sql, params } = step.query(fromIso, toIso, source, effectiveExcluded);
      let ids: string[] = [];
      try {
        const r = await this.pg.query(sql, params);
        ids = r.rows.map((row: any) => row.user_id ?? row.session_id).filter(Boolean);
      } catch (e: any) {
        this.log.error(`funnel step ${step.key} failed: ${e.message}`);
      }
      raw.push({ step, ids: new Set(ids) });
    }

    // 2. ОБРАТНОЕ накопительное объединение для user-шагов: когорта шага =
    //    объединение этого и всех последующих шагов (достиг позднего шага →
    //    прошёл и этот). Гарантирует монотонность «от большего к меньшему» И
    //    устойчиво к недо-инструментированным верхним событиям (напр. юзер
    //    написал, но его auth_succeeded не записан — он всё равно попадёт в
    //    «Залогинился»).
    const cohortSize: number[] = new Array(raw.length).fill(0);
    let acc = new Set<string>();
    for (let i = raw.length - 1; i >= 0; i--) {
      if (raw[i].step.identity !== 'user') continue;
      for (const u of raw[i].ids) acc.add(u);
      cohortSize[i] = acc.size;
    }

    // 3. Собираем шаги с процентами.
    const results: FunnelStep[] = [];
    let firstUserCount = 0;
    let firstSeen = false;
    let prevUserCount: number | null = null;
    for (let i = 0; i < raw.length; i++) {
      const step = raw[i].step;
      let count: number;
      let ratioToFirst: number | null = null;
      let ratioToPrev: number | null = null;

      if (step.identity === 'session') {
        count = raw[i].ids.size; // верх воронки — отдельный тип счёта
      } else {
        count = cohortSize[i];
        if (!firstSeen) {
          firstSeen = true;
          firstUserCount = count;
          ratioToFirst = count > 0 ? 100 : null;
        } else {
          ratioToFirst = firstUserCount > 0 ? (count / firstUserCount) * 100 : null;
          ratioToPrev = prevUserCount && prevUserCount > 0 ? (count / prevUserCount) * 100 : null;
        }
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
