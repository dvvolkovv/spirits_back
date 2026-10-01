/**
 * Код входа из SMS: где он лежит в Redis и как сверяется.
 *
 * Код живёт SMS_CODE_TTL_SECONDS и даёт не больше SMS_CODE_MAX_ATTEMPTS
 * попыток. Попытка, на которой лимит исчерпан неверным кодом, гасит код:
 * дальше нужен новый (повторный запрос SMS заводит новый код и обнуляет
 * счётчик). Верный код тоже гасится — он одноразовый.
 *
 * Проверка общая для входа (check-code) и привязки телефона к аккаунту
 * (auth/identities/link/phone): сверять `sc-<phone>` в обход неё нельзя.
 */

export const SMS_CODE_TTL_SECONDS = 300;
export const SMS_CODE_MAX_ATTEMPTS = 5;

export const smsCodeKey = (phone: string) => `sc-${phone}`;
export const smsAttemptsKey = (phone: string) => `sc-att-${phone}`;

export type SmsCodeCheck = 'ok' | 'invalid' | 'too_many_attempts';

/** Те методы RedisService, которые нужны проверке. */
export interface SmsCodeStore {
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
}

/**
 * Сверить код. 'ok' — код верный и уже погашен; 'invalid' — неверный, истёк
 * или не запрашивался; 'too_many_attempts' — лимит исчерпан, код погашен.
 *
 * Порядок шагов важен для параллельных запросов. Номер попытки берётся
 * атомарным INCR ДО чтения кода, и сравнивают только первые
 * SMS_CODE_MAX_ATTEMPTS попыток — сколько бы запросов ни пришло разом,
 * остальные получают отказ, не глядя на код. Код читается после INCR, поэтому
 * сравнение всегда идёт с действующим кодом, а не с погашенным.
 *
 * Гасим сначала код, потом счётчик: пока код есть, счётчик не обнуляется.
 */
export async function verifySmsCode(store: SmsCodeStore, phone: string, code: string): Promise<SmsCodeCheck> {
  // Кода нет — нечего и считать: не заводим счётчик на каждый случайный номер.
  if (!(await store.get(smsCodeKey(phone)))) return 'invalid';

  const attempt = await store.incr(smsAttemptsKey(phone));
  if (attempt === 1) await store.expire(smsAttemptsKey(phone), SMS_CODE_TTL_SECONDS);
  if (attempt > SMS_CODE_MAX_ATTEMPTS) {
    await burnSmsCode(store, phone);
    return 'too_many_attempts';
  }

  const stored = await store.get(smsCodeKey(phone));
  if (!stored) return 'invalid';
  if (stored !== code) {
    if (attempt >= SMS_CODE_MAX_ATTEMPTS) {
      await burnSmsCode(store, phone);
      return 'too_many_attempts';
    }
    return 'invalid';
  }

  await burnSmsCode(store, phone);
  return 'ok';
}

/** Погасить код и его счётчик попыток. */
export async function burnSmsCode(store: Pick<SmsCodeStore, 'del'>, phone: string): Promise<void> {
  await store.del(smsCodeKey(phone));
  await store.del(smsAttemptsKey(phone));
}
