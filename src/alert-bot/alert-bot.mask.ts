import * as crypto from 'crypto';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

export function maskText(input: string, ticketIds: Iterable<string> = []): string {
  const tickets = new Set(Array.from(ticketIds, (x) => x.toLowerCase()));
  let s = String(input);
  s = s.replace(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, '[скрыто]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[скрыто]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [скрыто]');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[скрыто]');
  s = s.replace(/([?&](?:token|key|secret)=)[^&#\s]+/gi, '$1[скрыто]');
  s = s.replace(UUID, (id) => tickets.has(id.toLowerCase()) ? `#${id.slice(0, 8)}` : '[id]');
  s = s.replace(/\b[0-9a-f]{32,}\b/gi, '[скрыто]');
  s = s.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (mail) => `${mail[0]}***@${mail.split('@')[1]}`);
  s = s.replace(/(?<!\d)(\+?\d[\d\s().-]{8,}\d)(?!\d)/g, (raw) => {
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15
      ? `+${digits[0]} *** *** ${digits.slice(-2)}`
      : raw;
  });
  return s;
}

export function maskForModel(value: unknown): unknown {
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map(maskForModel);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskForModel(v)]));
  }
  return value;
}

export function userLabel(userId: string, name?: string | null): { user: string; name: string | null } {
  const salt = process.env.RELAY_FS_SALT;
  if (!salt) throw new Error('RELAY_FS_SALT required');
  const label = crypto.createHmac('sha256', salt).update(`alert-bot:${userId}`).digest('hex').slice(0, 6);
  return { user: `u:${label}`, name: name || null };
}

export function toolText(value: unknown): string {
  const json = JSON.stringify(maskForModel(value)) ?? 'null';
  if (Buffer.byteLength(json) <= 8192) return json;
  const chars = Array.from(json);
  let out = chars.slice(0, 7800).join('');
  while (Buffer.byteLength(`${out}\n…[обрезано]`) > 8192) out = Array.from(out).slice(0, -1).join('');
  return `${out}\n…[обрезано]`;
}
