/**
 * Проба ассистента без регистрации (spec 2026-10-30-guest-trial-design.md):
 * общие типы, лимиты по умолчанию и сроки.
 */

/** off — проба выключена; preview — только по ссылке с ?trial=1; on — всем новым устройствам. */
export type GuestMode = 'off' | 'preview' | 'on';

export interface GuestLimits {
  /** Ответов ассистента до просьбы войти. */
  answersPerTrial: number;
  /** Длина одного сообщения гостя, знаков. */
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

/** Сколько живёт неперенесённая проба после последнего сообщения (и приписка о ней). */
export const GUEST_TRIAL_TTL_DAYS = 7;
/** Сколько живёт строка перенесённой пробы — без текста, для статистики. */
export const GUEST_CLAIMED_ROW_TTL_DAYS = 90;
/** Сколько ждём Redis: ioredis при недоступности висит десятки секунд, а не падает. */
export const GUEST_REDIS_TIMEOUT_MS = 2_000;
/** Срок одного гостевого хода: инструментов нет, ответ приходит за десятки секунд. */
export const GUEST_TURN_TIMEOUT_MS = 120_000;
/** Маша идёт мимо релея (chat.service: agent.id === 3) и читает историю из базы сама. */
export const MASHA_AGENT_ID = 3;

export interface GuestHistoryMessage {
  sender_type: 'human' | 'ai';
  content: string;
}

export function parseMode(raw: unknown): GuestMode {
  return raw === 'on' || raw === 'preview' ? raw : 'off';
}

/**
 * Лимиты из базы поверх base. Принимается только целое больше нуля, остальное
 * попадает в ignored — опечатку видно в ответе админ-ручки и в логе, а не по
 * тому, что потолок «не поднялся».
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
      const n = Number(src[key]);
      if (Number.isSafeInteger(n) && n > 0) limits[key] = n;
      else ignored.push(`${key}=${String(src[key])}`);
    }
  }
  return { limits, ignored };
}
