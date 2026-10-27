import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** Ссылка на вход живёт 15 минут (спека, «Сценарий владельца»). */
export const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Свой ключ из секрета клиента и адреса возврата. Секрет уходит Google при обмене кода,
 * а подпись state — наша. Адрес возврата в ключе: у стенда и прода один клиент OAuth,
 * и без него state, выданный стендом, подошёл бы проду.
 */
function key(secret: string, audience: string): Buffer {
  return createHash('sha256').update(`linkeon-shorts-youtube-state:${audience}:${secret}`).digest();
}

function sign(secret: string, audience: string, payload: string): string {
  return createHmac('sha256', key(secret, audience)).update(payload).digest('base64url');
}

/** state для адреса входа: чат владельца, срок, случайное число — и подпись. audience — адрес возврата среды. */
export function signState(
  secret: string,
  audience: string,
  chatId: number,
  now = Date.now(),
  nonce = randomBytes(9).toString('base64url'),
): string {
  const payload = Buffer.from(JSON.stringify({ c: chatId, e: now + STATE_TTL_MS, n: nonce })).toString('base64url');
  return `${payload}.${sign(secret, audience, payload)}`;
}

/** Чат владельца из state или null: подпись не сошлась (в том числе другая среда), срок вышел, форма чужая. */
export function verifyState(secret: string, audience: string, state: unknown, now = Date.now()): { chatId: number } | null {
  if (!secret || !audience || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, sig] = parts;
  const expected = Buffer.from(sign(secret, audience, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let body: any;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Number.isFinite(body?.c) || !Number.isFinite(body?.e) || body.e <= now) return null;
  return { chatId: Number(body.c) };
}
