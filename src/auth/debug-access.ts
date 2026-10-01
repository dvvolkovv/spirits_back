import { timingSafeEqual } from 'crypto';

/**
 * Доступ к debug-ручкам (/webhook/debug/*): код входа из Redis, токен ссылки
 * входа по почте, начисление токенов.
 *
 * Ручки нужны смоуку и e2e на живых средах (DEBUG_SMS_CODES=true); доступ
 * только по секрету из .env сервера. Ручки работают при ТРЁХ условиях сразу:
 *
 *   1. DEBUG_SMS_CODES === 'true';
 *   2. DEBUG_SECRET задан и не короче DEBUG_SECRET_MIN_LENGTH знаков;
 *   3. заголовок X-Debug-Secret совпадает с DEBUG_SECRET.
 *
 * Без DEBUG_SECRET ручки выключены (fail closed). Секрет лежит только в .env
 * сервера, в репозиторий его не класть; deploy.sh дописывает его сам, если
 * строки нет, и передаёт смоуку.
 */

export const DEBUG_SECRET_HEADER = 'x-debug-secret';
export const DEBUG_SECRET_MIN_LENGTH = 32;

type DebugEnv = Partial<Record<'DEBUG_SMS_CODES' | 'DEBUG_SECRET', string | undefined>>;

/** Секрет из окружения, если он пригоден; иначе null (ручки выключены). */
function configuredSecret(env: DebugEnv): string | null {
  if (env.DEBUG_SMS_CODES !== 'true') return null;
  const secret = env.DEBUG_SECRET ?? '';
  return secret.length >= DEBUG_SECRET_MIN_LENGTH ? secret : null;
}

/** Включены ли debug-ручки вообще (флаг + пригодный секрет). Для лога на старте. */
export function isDebugConfigured(env: DebugEnv = process.env): boolean {
  return configuredSecret(env) !== null;
}

/**
 * Пускать ли запрос с таким значением заголовка X-Debug-Secret.
 *
 * Сравнение — timingSafeEqual: время ответа не подсказывает, сколько первых
 * знаков угадано. timingSafeEqual бросает на буферах разной длины, поэтому
 * длину сверяем заранее — иначе заголовок «не той длины» ронял бы запрос в 500.
 */
export function isDebugRequestAllowed(provided: unknown, env: DebugEnv = process.env): boolean {
  const secret = configuredSecret(env);
  if (secret === null) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Белый список почт для debug/email-token — дополнительное ограничение поверх
 * секрета: ручка отвечает только для адресов, которыми пользуются тесты.
 *
 * Почты, которыми пользуются тесты (сверено 01.10.2026):
 *   - e2e-test-<ts>@example.com — tests/e2e.test.js этого репо;
 *   - claude.itest@linkeon.io, claude.link+<ts>@linkeon.io — интеграционные
 *     тесты мобилки (linkeon_mobile/integration_test).
 *
 * example.com зарезервирован (RFC 2606): почта туда не доставляется, поэтому
 * аккаунт на нём бывает только тестовым. На linkeon.io пускаем лишь служебный
 * префикс claude. — живые ящики домена (support@ и т.п.) сюда не попадают.
 */
export function isTestEmail(email: string): boolean {
  if (/^[^@\s]+@example\.com$/.test(email)) return true;
  return /^claude\.[a-z0-9._+-]+@linkeon\.io$/.test(email);
}
