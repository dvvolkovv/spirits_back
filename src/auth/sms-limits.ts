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
 * Считаются только настоящие отправки: тестовые номера и путь «код уже
 * выслан» сюда не доходят (см. AuthService.requestSmsCode). Квота берётся до
 * записи кода и до SMS: при отказе нет ни кода, ни отправки.
 *
 * Окна фиксированные: первый удар заводит счётчик и ставит ему срок окна
 * (INCR, затем EXPIRE). Отказ возвращает всё, что успел насчитать: запрос,
 * который не ушёл, ничьей квоты не тратит. Иначе атака на один номер выедала
 * бы общий лимит, а человек, упёршийся в общий, заодно сжигал бы свой.
 */

export interface SmsLimits {
  /** Минимальный зазор между SMS на один номер, в секундах. */
  phoneIntervalSec: number;
  phonePerHour: number;
  phonePerDay: number;
  /** Все номера вместе. */
  globalPerHour: number;
  globalPerDay: number;
  /** Номера не на 7 — отдельный, более строгий потолок внутри общего. */
  intlPerHour: number;
  intlPerDay: number;
}

/**
 * Пороги по умолчанию — единственное место, где они заданы.
 *
 * Реальный объём за 30 дней до 06.10.2026 без тестовых номеров: 13 SMS за
 * 11 дней, максимум 1 в час, 2 в сутки, 2 на номер в сутки, все на +7.
 * Пороги выше этого в разы: живой человек в них не упирается, а у накрутки
 * появляется потолок — не больше 100 SMS (около 900 ₽) в сутки на всё.
 * Номера других стран веб и мобилка поддерживают сознательно, запрещать их
 * нельзя; но живых таких отправок не было ни одной, поэтому их потолок ниже.
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
});

export const SMS_LIMIT_ENV: Readonly<Record<keyof SmsLimits, string>> = Object.freeze({
  phoneIntervalSec: 'SMS_LIMIT_PHONE_INTERVAL_SEC',
  phonePerHour: 'SMS_LIMIT_PHONE_PER_HOUR',
  phonePerDay: 'SMS_LIMIT_PHONE_PER_DAY',
  globalPerHour: 'SMS_LIMIT_GLOBAL_PER_HOUR',
  globalPerDay: 'SMS_LIMIT_GLOBAL_PER_DAY',
  intlPerHour: 'SMS_LIMIT_INTL_PER_HOUR',
  intlPerDay: 'SMS_LIMIT_INTL_PER_DAY',
});

/**
 * Пороги с учётом переопределений из окружения.
 *
 * Читать при каждом запросе, а не при загрузке модуля: .env подхватывает
 * ConfigModule уже после импорта, и прочитанная заранее константа молча
 * осталась бы значением по умолчанию. Принимается только целое больше нуля;
 * остальное игнорируется и попадает в `ignored`, чтобы опечатку было видно
 * в логе, а не по тому, что лимит «не поднялся».
 */
export function smsLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): { limits: SmsLimits; ignored: string[] } {
  const limits: SmsLimits = { ...SMS_LIMIT_DEFAULTS };
  const ignored: string[] = [];
  for (const field of Object.keys(SMS_LIMIT_ENV) as (keyof SmsLimits)[]) {
    const name = SMS_LIMIT_ENV[field];
    const raw = env[name]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) limits[field] = n;
    else ignored.push(`${name}=${raw}`);
  }
  return { limits, ignored };
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
  | 'global_day';

/** Лимит на все номера сразу (общий или для номеров не на 7): его срабатывание — признак атаки. */
export const isSharedScope = (scope: SmsLimitScope): boolean => !scope.startsWith('phone_');

export interface SmsLimitRule {
  scope: SmsLimitScope;
  key: string;
  max: number;
  windowSec: number;
}

const HOUR = 3600;
const DAY = 86400;

/**
 * Счётчики, которые тратит одна SMS на этот номер, в порядке проверки.
 *
 * Номер — первым: отказ по номеру не должен касаться общих счётчиков даже на
 * мгновение, иначе долбёжка одного номера мешала бы чужим входам.
 */
export function smsLimitRules(phone: string, limits: SmsLimits): SmsLimitRule[] {
  const rules: SmsLimitRule[] = [
    { scope: 'phone_interval', key: `sms-lim:phone:${phone}:interval`, max: 1, windowSec: limits.phoneIntervalSec },
    { scope: 'phone_hour', key: `sms-lim:phone:${phone}:h`, max: limits.phonePerHour, windowSec: HOUR },
    { scope: 'phone_day', key: `sms-lim:phone:${phone}:d`, max: limits.phonePerDay, windowSec: DAY },
  ];
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

/** Те методы RedisService, которые нужны лимитам. */
export interface SmsLimitStore {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  ttl(key: string): Promise<number>;
}

export type SmsQuotaVerdict =
  | { ok: true }
  | { ok: false; scope: SmsLimitScope; retryAfterSec: number };

/**
 * Взять квоту на одну SMS. `ok` — квота взята, можно слать; иначе отказ:
 * `scope` — лимит, на котором запрос остановился, `retryAfterSec` — через
 * сколько секунд освободятся все заполненные окна этого номера.
 *
 * INCR атомарен, поэтому разом пришедшие запросы получают разные номера и
 * сверх порога не проходит ни один. Проверка «сначала прочитать, потом
 * прибавить» пропустила бы пачку параллельных запросов целиком.
 */
export async function takeSmsQuota(store: SmsLimitStore, phone: string, limits: SmsLimits): Promise<SmsQuotaVerdict> {
  const rules = smsLimitRules(phone, limits);
  const taken: SmsLimitRule[] = [];
  let tripped: SmsLimitRule | null = null;

  for (const rule of rules) {
    const n = await store.incr(rule.key);
    taken.push(rule);
    // Срок окна ставит первый удар. Если тот EXPIRE не дошёл (обрыв связи,
    // рестарт между командами), счётчик остался бы вечным и однажды закрыл бы
    // отправку насовсем, — поэтому каждый следующий удар срок проверяет.
    if (n === 1 || (await store.ttl(rule.key)) === -1) await store.expire(rule.key, rule.windowSec);
    if (n > rule.max) {
      tripped = rule;
      break;
    }
  }
  if (!tripped) return { ok: true };

  // SMS не уйдёт — возвращаем всё, что этот запрос насчитал.
  for (const rule of taken) {
    try {
      await store.decr(rule.key);
    } catch {
      // Не вернули — счётчик завышен до конца окна. Это лишь строже,
      // а отказ клиенту важнее превращать не в 500, а в честный 429.
    }
  }

  return { ok: false, scope: tripped.scope, retryAfterSec: await secondsUntilFree(store, rules) };
}

/**
 * Через сколько секунд освободятся все заполненные окна этого номера.
 *
 * Не только того лимита, что сработал: упёршемуся в часовой лимит в первую
 * минуту после SMS сказать «через минуту» — значит через минуту отказать
 * снова, уже на час.
 */
async function secondsUntilFree(store: SmsLimitStore, rules: SmsLimitRule[]): Promise<number> {
  let wait = 0;
  for (const rule of rules) {
    const count = Number(await store.get(rule.key));
    if (!(count >= rule.max)) continue;
    let ttl = await store.ttl(rule.key);
    if (ttl === -1) {
      await store.expire(rule.key, rule.windowSec);
      ttl = rule.windowSec;
    }
    wait = Math.max(wait, ttl);
  }
  return Math.max(1, wait);
}

/** Номер для логов: только последние четыре цифры. */
export const maskPhone = (phone: string): string => `***${String(phone).slice(-4)}`;
