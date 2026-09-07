import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Проверка `X-Webhook-Signature` вебхуков Attendee.
 *
 * Своя реализация, а не `voice-call/hmac.ts`: там hex от HMAC над СЫРЫМИ
 * байтами тела, здесь base64 над КАНОНИЗИРОВАННЫМ JSON. Из-за этого различия
 * сырое тело нам не нужно вовсе — наоборот, JSON надо разобрать и пересобрать
 * канонично, поэтому на этот путь в main.ts ничего навешивать не требуется.
 *
 * Канонизация подтверждена по исходникам attendee-labs/attendee
 * (bots/webhook_utils.py::sign_payload):
 *   json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
 * — рекурсивно отсортированные ключи, без пробелов, юникод не экранируется
 * (JSON.stringify в JS и так не экранирует не-ASCII, это и не нужно
 * повторять отдельно), порядок элементов массива сохраняется.
 */

/**
 * JSON с рекурсивно отсортированными ключами и без пробелов.
 *
 * Порядок элементов массива сохраняется: массив — это данные, а не набор.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(',');
  return `{${body}}`;
}

/** Сравнение constant-time. Любой мусор — false, а не исключение. */
export function verifyAttendeeSignature(
  secret: string,
  payload: unknown,
  signature: string,
): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = createHmac('sha256', secret).update(canonicalJson(payload), 'utf8').digest('base64');
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature, 'base64'), Buffer.from(expected, 'base64'));
  } catch {
    return false;
  }
}
