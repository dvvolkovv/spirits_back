/**
 * Лимиты отправки SMS с кодом входа.
 *
 * Запросить SMS может кто угодно — эндпоинт публичный, а каждая стоит денег
 * (SMS Aero, около 9 ₽). Лимит попыток ввода кода (sms-code.ts) замкнул петлю
 * «5 неверных → код погашен → новый запрос → новая SMS», и без потолка она
 * гнала бы SMS на один номер бесконечно. Ограничить по IP нельзя: прод стоит
 * за прокси Selectel, и в X-Forwarded-For у всех один и тот же адрес
 * (проверено перехватом 06.10.2026). Поэтому считаем по номеру и по всем
 * номерам сразу.
 *
 * Общий потолок разделён надвое. Известные номера (есть аккаунт или способ
 * входа) считаются в своём общем счётчике `known`: накрутка на случайные
 * номера выедает `global`/`intl` и не запирает вход тем, кто уже с нами.
 * Новые номера — в `global`, а не на 7 — ещё и в `intl`.
 *
 * Заполненный `global`/`intl` новому номеру не виден: ответ как при успехе,
 * но SMS не уходит и код не пишется (AuthService.requestSmsCode). Иначе по
 * разнице 429/200 можно было бы узнать, зарегистрирован ли номер. 429 бывает
 * только по лимиту самого номера и по `known`.
 *
 * Считаются только настоящие отправки: тестовые номера и путь «код уже
 * выслан» сюда не доходят. Проверка и учёт — один атомарный Lua-скрипт
 * (quota.ts): отказ ничего не пишет.
 */
import { limitsFromEnv, QuotaRule, QuotaStore, takeQuota } from './quota';

export interface SmsLimits {
  /** Минимальный зазор между SMS на один номер, в секундах. */
  phoneIntervalSec: number;
  phonePerHour: number;
  phonePerDay: number;
  /** Новые номера вместе. */
  globalPerHour: number;
  globalPerDay: number;
  /** Новые номера не на 7 — отдельный, более строгий потолок внутри общего. */
  intlPerHour: number;
  intlPerDay: number;
  /** Известные номера вместе. */
  knownPerHour: number;
  knownPerDay: number;
}

/**
 * Пороги по умолчанию — единственное место, где они заданы.
 *
 * Реальный объём за 30 дней до 06.10.2026 без тестовых номеров: 13 SMS за
 * 11 дней, максимум 1 в час, 2 в сутки, 2 на номер в сутки, все на +7.
 * Пороги выше этого в разы: живой человек в них не упирается, а у накрутки
 * появляется потолок — не больше 100 SMS (около 900 ₽) в сутки на новые
 * номера. Номера других стран веб и мобилка поддерживают сознательно,
 * запрещать их нельзя; но живых таких отправок не было ни одной, поэтому их
 * потолок ниже. Известным номерам потолок выше: он защищает от массовой
 * рассылки по базе, а не от одного входа.
 *
 * Поднять без правки кода — переменными из SMS_LIMIT_ENV в .env бэкенда;
 * нужен перезапуск процесса.
 */
export const SMS_LIMIT_DEFAULTS: Readonly<SmsLimits> = Object.freeze({
  phoneIntervalSec: 60,
  phonePerHour: 3,
  phonePerDay: 5,
  globalPerHour: 30,
  globalPerDay: 100,
  intlPerHour: 5,
  intlPerDay: 15,
  knownPerHour: 60,
  knownPerDay: 200,
});

export const SMS_LIMIT_ENV: Readonly<Record<keyof SmsLimits, string>> = Object.freeze({
  phoneIntervalSec: 'SMS_LIMIT_PHONE_INTERVAL_SEC',
  phonePerHour: 'SMS_LIMIT_PHONE_PER_HOUR',
  phonePerDay: 'SMS_LIMIT_PHONE_PER_DAY',
  globalPerHour: 'SMS_LIMIT_GLOBAL_PER_HOUR',
  globalPerDay: 'SMS_LIMIT_GLOBAL_PER_DAY',
  intlPerHour: 'SMS_LIMIT_INTL_PER_HOUR',
  intlPerDay: 'SMS_LIMIT_INTL_PER_DAY',
  knownPerHour: 'SMS_LIMIT_KNOWN_PER_HOUR',
  knownPerDay: 'SMS_LIMIT_KNOWN_PER_DAY',
});

/** Пороги с переопределениями SMS_LIMIT_* — читать на каждый запрос (quota.ts). */
export function smsLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): { limits: SmsLimits; ignored: string[] } {
  return limitsFromEnv<SmsLimits>(SMS_LIMIT_DEFAULTS, SMS_LIMIT_ENV, env);
}

/**
 * Номер, на который можно слать SMS: только цифры, с кодом страны, без «+»
 * (E.164), первая цифра не ноль.
 *
 * Нижняя граница — 7 цифр, а не 10: у Фарерских островов, Гренландии,
 * Андорры, Новой Каледонии и ещё десятка территорий мобильный номер вместе
 * с кодом страны короче десяти цифр (у Токелау — семь), а веб-форма
 * (libphonenumber-js) пропускает их как валидные. Верхняя — 15, предел E.164.
 */
export const SMS_PHONE_MIN_DIGITS = 7;
export const SMS_PHONE_MAX_DIGITS = 15;
const SMS_PHONE_RE = new RegExp(`^[1-9]\\d{${SMS_PHONE_MIN_DIGITS - 1},${SMS_PHONE_MAX_DIGITS - 1}}$`);

export function isSmsPhone(phone: unknown): phone is string {
  return typeof phone === 'string' && SMS_PHONE_RE.test(phone);
}

export type SmsLimitScope =
  | 'phone_interval'
  | 'phone_hour'
  | 'phone_day'
  | 'intl_hour'
  | 'intl_day'
  | 'global_hour'
  | 'global_day'
  | 'known_hour'
  | 'known_day';

/** Лимит на много номеров сразу (global, intl, known): его срабатывание — признак накрутки. */
export const isSharedScope = (scope: SmsLimitScope): boolean => !scope.startsWith('phone_');

export interface SmsLimitRule extends QuotaRule {
  scope: SmsLimitScope;
}

const HOUR = 3600;
const DAY = 86400;

/**
 * Счётчики, которые тратит одна SMS на этот номер, в порядке старшинства.
 *
 * Порядок несёт смысл: исход отказа решает первое заполненное окно, и лимит
 * самого номера стоит первым. Новый номер, исчерпавший свой лимит, получает
 * 429 даже при закрытом `global` — ровно как известный. Если бы первым стоял
 * общий, такой номер получил бы «успех», а известный — 429, и разница выдала
 * бы, зарегистрирован ли номер.
 */
export function smsLimitRules(phone: string, known: boolean, limits: SmsLimits): SmsLimitRule[] {
  const rules: SmsLimitRule[] = [
    { scope: 'phone_interval', key: `sms-lim:phone:${phone}:interval`, max: 1, windowSec: limits.phoneIntervalSec },
    { scope: 'phone_hour', key: `sms-lim:phone:${phone}:h`, max: limits.phonePerHour, windowSec: HOUR },
    { scope: 'phone_day', key: `sms-lim:phone:${phone}:d`, max: limits.phonePerDay, windowSec: DAY },
  ];
  if (known) {
    rules.push(
      { scope: 'known_hour', key: 'sms-lim:known:h', max: limits.knownPerHour, windowSec: HOUR },
      { scope: 'known_day', key: 'sms-lim:known:d', max: limits.knownPerDay, windowSec: DAY },
    );
    return rules;
  }
  if (!phone.startsWith('7')) {
    rules.push(
      { scope: 'intl_hour', key: 'sms-lim:intl:h', max: limits.intlPerHour, windowSec: HOUR },
      { scope: 'intl_day', key: 'sms-lim:intl:d', max: limits.intlPerDay, windowSec: DAY },
    );
  }
  rules.push(
    { scope: 'global_hour', key: 'sms-lim:global:h', max: limits.globalPerHour, windowSec: HOUR },
    { scope: 'global_day', key: 'sms-lim:global:d', max: limits.globalPerDay, windowSec: DAY },
  );
  return rules;
}

/** Заполненный общий счётчик: о нём сообщают раз за окно (limit-alert.ts). */
export interface SharedLimitHit {
  scope: SmsLimitScope;
  max: number;
  /** Отметка «уже сообщили»: sms-lim:alerted:<global|intl|known>:<h|d>. */
  alertKey: string;
  windowLeftMs: number;
}

export type SmsQuotaVerdict =
  /** Учтено во всех окнах — можно слать. */
  | { kind: 'ok' }
  /** Отказ, который клиент видит: 429 со сроком. */
  | { kind: 'limited'; scope: SmsLimitScope; retryAfterSec: number; shared: SharedLimitHit[] }
  /** Новому номеру закрыт общий потолок: ответ как при успехе, SMS нет. */
  | { kind: 'suppressed'; shared: SharedLimitHit[] };

/**
 * Взять квоту на одну SMS. Отказ ничего не учитывает (quota.ts).
 *
 * `retryAfterSec` — через сколько освободятся все заполненные окна, которые
 * этому номеру видны: свои и, у известного, `known`. Не только того, что
 * сработало: упёршемуся в часовой лимит в первую минуту после SMS сказать
 * «через минуту» — значит через минуту отказать снова. `global`/`intl` в срок
 * нового номера не входят — это тоже выдало бы закрытый потолок.
 */
export async function takeSmsQuota(
  store: QuotaStore,
  phone: string,
  known: boolean,
  limits: SmsLimits,
): Promise<SmsQuotaVerdict> {
  const rules = smsLimitRules(phone, known, limits);
  const reply = await takeQuota(store, rules);
  if (reply.counted) return { kind: 'ok' };

  const full = rules
    .map((rule, i) => ({ rule, leftMs: reply.leftMs[i] }))
    .filter((f) => f.leftMs >= 0);
  if (full.length === 0) throw new Error('takeSmsQuota: отказ без заполненного окна');

  const shared: SharedLimitHit[] = full
    .filter((f) => isSharedScope(f.rule.scope))
    .map((f) => ({
      scope: f.rule.scope,
      max: f.rule.max,
      alertKey: f.rule.key.replace(/^sms-lim:/, 'sms-lim:alerted:'),
      windowLeftMs: f.leftMs,
    }));

  const decisive = full[0];
  if (!known && isSharedScope(decisive.rule.scope)) return { kind: 'suppressed', shared };

  const visibleLeftMs = full
    .filter((f) => known || !isSharedScope(f.rule.scope))
    .map((f) => f.leftMs);
  const retryAfterSec = Math.max(1, Math.ceil(Math.max(...visibleLeftMs) / 1000));
  return { kind: 'limited', scope: decisive.rule.scope, retryAfterSec, shared };
}

/** Номер для логов: только последние четыре цифры. */
export const maskPhone = (phone: string): string => `***${String(phone).slice(-4)}`;
