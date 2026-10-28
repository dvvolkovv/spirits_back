import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const rawKey = (): string => process.env.CALENDAR_SECRET_KEY || '';

/**
 * Ключ шифрования есть и годится: не короче 32 знаков (AES-256 берёт первые 32). Правило одно
 * на всех: без такого ключа encryptSecret и decryptSecret бросают, а вызывающие спрашивают его
 * заранее, когда шаг до шифрования необратим (YouTube роликов — одноразовый код Google).
 */
export function hasSecretKey(): boolean {
  return rawKey().length >= 32;
}

function key(): Buffer {
  if (!hasSecretKey()) throw new Error('CALENDAR_SECRET_KEY must be >= 32 chars');
  return Buffer.from(rawKey().slice(0, 32));
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const [iv, tag, enc] = payload.split(':').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
