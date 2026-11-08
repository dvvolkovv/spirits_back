import type { RetentionChannel } from './retention.types';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^7[0-9]{10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RETENTION_UID_SQL_RE = '^(7[0-9]{10}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$';

export function normalizeEmail(raw: unknown): string | null {
  const value = String(raw ?? '').trim().toLowerCase();
  return EMAIL_RE.test(value) ? value : null;
}

export function normalizePhone(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  const normalized = value.startsWith('+') ? value.slice(1) : value;
  return PHONE_RE.test(normalized) ? normalized : null;
}

export function isRetentionUserId(raw: unknown): boolean {
  const value = String(raw ?? '');
  return PHONE_RE.test(value) || UUID_RE.test(value);
}

export function selectRetentionChannel(contact: { email: string | null; phone: string | null }): RetentionChannel {
  if (contact.email) return 'email';
  if (contact.phone) return 'sms';
  return 'no_channel';
}
