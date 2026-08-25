import { createHmac, timingSafeEqual } from 'crypto';

/** hex-подпись HMAC-SHA256 над сырым телом запроса. */
export function signBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Сравнение constant-time. Любой мусор на входе — false, а не исключение:
 * ручка должна отвечать 401, а не 500.
 */
export function verifyBody(secret: string, rawBody: string, signature: string): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = signBody(secret, rawBody);
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
