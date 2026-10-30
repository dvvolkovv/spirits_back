import { QuotaReply, QuotaRule, QuotaStore, takeQuota } from '../auth/quota';
import { GuestLimits } from './guest-trial.types';
import { withTimeout } from './with-timeout';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export type GuestWindowScope = 'trials_hour' | 'trials_day' | 'answers_hour' | 'answers_day';

export interface GuestQuotaRule extends QuotaRule {
  scope: GuestWindowScope;
}

/** Новые пробы. Окна общие на всех гостей: адрес клиента за прокси my.linkeon.io не виден. */
export function trialRules(l: GuestLimits): GuestQuotaRule[] {
  return [
    { scope: 'trials_hour', key: 'guest-lim:trials:h', max: l.trialsPerHour, windowSec: HOUR },
    { scope: 'trials_day', key: 'guest-lim:trials:d', max: l.trialsPerDay, windowSec: DAY },
  ];
}

/** Гостевые ответы — тоже общие окна: они и есть худший случай для подписки. */
export function answerRules(l: GuestLimits): GuestQuotaRule[] {
  return [
    { scope: 'answers_hour', key: 'guest-lim:answers:h', max: l.answersPerHour, windowSec: HOUR },
    { scope: 'answers_day', key: 'guest-lim:answers:d', max: l.answersPerDay, windowSec: DAY },
  ];
}

export interface FullWindow {
  scope: GuestWindowScope;
  max: number;
  leftMs: number;
}

/**
 * counted — учтено во всех окнах; иначе не учтено нигде (quota.ts), и full
 * называет заполненные окна. redisDown — Redis не ответил вовремя или упал:
 * проба закрывается без учёта. Не союз типов: в бэке strictNullChecks
 * выключен, и булев признак союз не сужает.
 */
export interface GuestQuotaReply {
  counted: boolean;
  redisDown: boolean;
  full: FullWindow[];
}

export async function takeGuestQuota(store: QuotaStore, rules: GuestQuotaRule[], timeoutMs: number): Promise<GuestQuotaReply> {
  let reply: QuotaReply;
  try {
    reply = await withTimeout(takeQuota(store, rules), timeoutMs);
  } catch {
    return { counted: false, redisDown: true, full: [] };
  }
  if (reply.counted) return { counted: true, redisDown: false, full: [] };
  const full = rules
    .map((r, i) => ({ scope: r.scope, max: r.max, leftMs: reply.leftMs[i] }))
    .filter((f) => f.leftMs >= 0);
  return { counted: false, redisDown: false, full };
}
