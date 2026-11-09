import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { normalizeEmail } from './retention-recipient';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
const MAX_EMAIL_BYTES = 512;
const MAX_TOKEN_CHARS = 2048;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function retentionSecret(): Buffer {
  const hex = process.env.RETENTION_UNSUBSCRIBE_SECRET;
  if (!hex) throw new Error('retention_unsubscribe_secret_not_configured');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('retention_unsubscribe_secret_invalid');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptRetentionEmail(rawEmail: string): string {
  const key = retentionSecret();
  const email = normalizeEmail(rawEmail);
  if (!email || Buffer.byteLength(email, 'utf8') > MAX_EMAIL_BYTES) {
    throw new Error('invalid_email');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return Buffer.concat([
    Buffer.from([VERSION]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString('base64url');
}

export function decryptRetentionEmail(token: string): string | null {
  const key = retentionSecret();
  const encoded = String(token || '');
  if (encoded.length > MAX_TOKEN_CHARS || !BASE64URL_RE.test(encoded)) return null;

  let envelope: Buffer;
  try {
    envelope = Buffer.from(encoded, 'base64url');
  } catch {
    return null;
  }
  if (
    envelope.toString('base64url') !== encoded ||
    envelope.length <= ENVELOPE_HEADER_BYTES ||
    envelope[0] !== VERSION
  ) {
    return null;
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(1, 1 + IV_BYTES));
    decipher.setAuthTag(envelope.subarray(1 + IV_BYTES, ENVELOPE_HEADER_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(envelope.subarray(ENVELOPE_HEADER_BYTES)),
      decipher.final(),
    ]);
    const email = plaintext.toString('utf8');
    const normalized = normalizeEmail(email);
    if (
      !normalized ||
      normalized !== email ||
      Buffer.byteLength(email, 'utf8') > MAX_EMAIL_BYTES
    ) {
      return null;
    }
    return email;
  } catch {
    return null;
  }
}
