/**
 * Проба ассистента без регистрации (spec 2026-10-30-guest-trial-design.md):
 * общие типы, лимиты по умолчанию и сроки.
 */

/** off — проба выключена; preview — только по ссылке с ?trial=1; on — всем новым устройствам. */
export type GuestMode = 'off' | 'preview' | 'on';

export interface GuestLimits {
  /** Ответов ассистента до просьбы войти. */
  answersPerTrial: number;
  /**
   * Длина одного сообщения гостя, знаков. Фактический потолок сверху —
   * срез slice(0, 20000) в parseGuestTurnInput (guest-turn.service.ts) и
   * тело запроса ≤ 64 КБ на /webhook/guest (main.ts): ставить maxChars
   * больше этого бессмысленно — более длинное сообщение обрежется молча,
   * без ошибки клиенту.
   */
  maxChars: number;
  trialsPerHour: number;
  trialsPerDay: number;
  answersPerHour: number;
  answersPerDay: number;
  /** Гостевых ходов одновременно — бережёт процессор и память прода. */
  concurrentTurns: number;
}

/** Решения владельца 30.10.2026; строка limits в guest_trial_settings их перекрывает. */
export const DEFAULT_GUEST_LIMITS: Readonly<GuestLimits> = {
  answersPerTrial: 3,
  maxChars: 2000,
  trialsPerHour: 60,
  trialsPerDay: 200,
  answersPerHour: 100,
  answersPerDay: 300,
  concurrentTurns: 4,
};

/** Сколько живёт неперенесённая проба после последнего сообщения. */
export const GUEST_TRIAL_TTL_DAYS = 7;
/**
 * Срок жизни приписки о пробе (Redis, guest-carry.ts) — сутки, короче
 * GUEST_TRIAL_TTL_DAYS: приписка нужна только для первого хода через релей
 * после входа, дальше сессия релея помнит разговор сама. Короткий срок — чтобы
 * при удалении аккаунта и регистрации того же номера заново пересказ чужого
 * прежнего разговора не всплыл у нового владельца номера.
 */
export const GUEST_CARRY_TTL_SECONDS = 24 * 60 * 60;
/** Сколько живёт строка перенесённой пробы — без текста, для статистики. */
export const GUEST_CLAIMED_ROW_TTL_DAYS = 90;
/** Сколько ждём Redis: ioredis при недоступности висит десятки секунд, а не падает. */
export const GUEST_REDIS_TIMEOUT_MS = 2_000;
/**
 * То же ожидание Redis, но для чтения приписки о пробе (guest-carry.ts) в
 * streamUniversalAgent — горячем пути КАЖДОГО хода чата, а не только
 * гостевых. Меньше GUEST_REDIS_TIMEOUT_MS сознательно: при лежащем Redis
 * ioredis висит 23–63 с, и даже разница в полсекунды здесь умножается на
 * весь трафик чата (все аккаунты), а не только на гостевые ходы.
 */
export const GUEST_CARRY_READ_TIMEOUT_MS = 1_500;
/** Срок одного гостевого хода: инструментов нет, ответ приходит за десятки секунд. */
export const GUEST_TURN_TIMEOUT_MS = 120_000;
/** Сколько последних сообщений истории (пар человек/ассистент) класть в промпт гостя —
 *  две пары: больше не нужно для короткой пробы, и промпт не растёт неограниченно. */
export const GUEST_PROMPT_HISTORY_MESSAGES = 4;
/** Маша идёт мимо релея (chat.service: agent.id === 3) и читает историю из базы сама. */
export const MASHA_AGENT_ID = 3;

/**
 * Имена событий, которые пишет только сервер (ход гостя — цена и итог,
 * перенос в аккаунт, закрытие пробы по лимиту, причина отказа хода; см.
 * guest-turn.service.ts и guest-claim.service.ts). events/track
 * (src/events/events.controller.ts) открыта без JWT и принимает любое имя —
 * подделанный guest_trial_answer с мусорным cost_usd рушит статистику
 * admin/guest-trial на дни вперёд, а guest_trial_error с произвольным reason
 * заводит фальшивый ключ воронки (разбор ревью A10). Клиентские
 * guest_trial_view/guest_trial_wall в этот список не входят — их и шлёт
 * фронт через ту же открытую ручку.
 */
export const GUEST_SERVER_EVENTS: readonly string[] = [
  'guest_trial_answer',
  'guest_trial_claimed',
  'guest_trial_closed',
  'guest_trial_error',
];

export interface GuestHistoryMessage {
  sender_type: 'human' | 'ai';
  content: string;
}

export function parseMode(raw: unknown): GuestMode {
  return raw === 'on' || raw === 'preview' ? raw : 'off';
}

/**
 * Единственное число лимита: number или строка из цифр (после trim), целое
 * больше нуля. Строже простого Number(...) — тот молча принимал дробные
 * строки ('42.0'), экспоненту ('5e2') и т.п. Остальное — null.
 */
export function toLimit(raw: unknown): number | null {
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    n = Number(raw.trim());
  } else {
    return null;
  }
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Лимиты из базы поверх base. Принимается только целое больше нуля, остальное
 * попадает в ignored — опечатку видно в ответе админ-ручки и в логе, а не по
 * тому, что потолок «не поднялся». Неизвестные ключи строки базы терпим
 * молча — совместимость со старыми/будущими версиями объекта; за опечатки в
 * ключах, которые вводит сам админ, отвечает parseLimitsPatch.
 */
export function sanitizeLimits(
  raw: unknown,
  base: Readonly<GuestLimits> = DEFAULT_GUEST_LIMITS,
): { limits: GuestLimits; ignored: string[] } {
  const limits: GuestLimits = { ...base };
  const ignored: string[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const src = raw as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_GUEST_LIMITS) as Array<keyof GuestLimits>) {
      if (!(key in src)) continue;
      const n = toLimit(src[key]);
      if (n !== null) limits[key] = n;
      else ignored.push(`${key}=${String(src[key])}`);
    }
  }
  return { limits, ignored };
}

/**
 * Патч лимитов из админ-ручки. В отличие от sanitizeLimits (терпит чужие
 * ключи строки базы молча — совместимость), здесь неизвестный ключ — это
 * опечатка админа и должен быть виден в ответе ручки, а не потеряться молча.
 */
export function parseLimitsPatch(raw: unknown): { patch: Partial<GuestLimits>; ignored: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { patch: {}, ignored: ['limits: ожидался объект'] };
  }
  const src = raw as Record<string, unknown>;
  const patch: Partial<GuestLimits> = {};
  const ignored: string[] = [];
  for (const key of Object.keys(src)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_GUEST_LIMITS, key)) {
      ignored.push(`${key}: неизвестный ключ`);
      continue;
    }
    const n = toLimit(src[key]);
    if (n !== null) patch[key as keyof GuestLimits] = n;
    else ignored.push(`${key}=${String(src[key])}`);
  }
  return { patch, ignored };
}
