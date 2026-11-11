import * as crypto from 'crypto';

const UUID = /(?<![A-Za-z0-9])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9])/gi;

export function maskSecrets(input: string): string {
  let s = String(input);
  s = s.replace(/(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/:@]+:)[^\s\/@]+@/g, '$1[скрыто]@');
  s = s.replace(
    /(\b(?:export\s+)?[A-Za-z_][A-Za-z0-9_-]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]KEY)[A-Za-z0-9_-]*\s*=\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;]+)/gi,
    '$1[скрыто]',
  );
  s = s.replace(/(?<![A-Za-z0-9_-])\d{8,10}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/g, '[скрыто]');
  s = s.replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g, '[скрыто]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [скрыто]');
  s = s.replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])/g, '[скрыто]');
  s = s.replace(/([?&](?:token|key|secret)=)[^&#\s]+/gi, '$1[скрыто]');
  s = s.replace(/\b(?:password|passwd|secret|api[_-]?key)\s*=\s*[^\s;]+/gi, (match) => `${match.split('=')[0]}=[скрыто]`);
  return s;
}

export function maskText(input: string, ticketIds: Iterable<string> = []): string {
  const tickets = new Set(Array.from(ticketIds, (x) => x.toLowerCase()));
  let s = maskSecrets(input);
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

const TEMPORAL_KEYS = new Set([
  'at', 'ts', 'time', 'timestamp', 'date', 'from', 'to', 'since', 'until',
  'createdat', 'updatedat', 'latestts', 'expiresat', 'dueat',
]);

function isTemporalKey(key: string): boolean {
  return TEMPORAL_KEYS.has(key.replace(/[\s_-]/g, '').toLowerCase());
}

function isUnixTimestamp(value: number): boolean {
  const seconds = value >= 1_000_000_000 && value <= 4_102_444_800;
  const milliseconds = value >= 100_000_000_000 && value <= 4_102_444_800_000;
  return seconds || milliseconds;
}

export function maskForModel(value: unknown, key?: string): unknown {
  if (typeof value === 'string') return maskText(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    const digits = String(Math.abs(value));
    if (digits.length >= 10 && digits.length <= 15) {
      if (key && isTemporalKey(key) && isUnixTimestamp(value)) return value;
      return maskText(String(value));
    }
  }
  if (Array.isArray(value)) return value.map((item) => maskForModel(item, key));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const entries: [string, unknown][] = [];
    const keys = new Set<string>();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'function') continue;
      const maskedKey = maskText(key);
      let uniqueKey = maskedKey;
      let collision = 2;
      while (keys.has(uniqueKey)) uniqueKey = `${maskedKey}#${collision++}`;
      keys.add(uniqueKey);
      entries.push([uniqueKey, maskForModel(item, key)]);
    }
    return Object.fromEntries(entries);
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
  const serialized = JSON.stringify(maskForModel(value)) ?? 'null';
  const timestamps: string[] = [];
  const protectedJson = serialized.replace(
    /("((?:[^"\\]|\\.)*)"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])/g,
    (match, prefix: string, key: string, numeric: string) => {
      if (!isTemporalKey(key) || !isUnixTimestamp(Number(numeric))) return match;
      const placeholder = `__ALERT_BOT_TIMESTAMP_${timestamps.length}__`;
      timestamps.push(numeric);
      return `${prefix}${placeholder}`;
    },
  );
  let masked = maskText(protectedJson);
  timestamps.forEach((timestamp, index) => {
    masked = masked.replace(`__ALERT_BOT_TIMESTAMP_${index}__`, timestamp);
  });
  let json = masked;
  try {
    JSON.parse(masked);
  } catch {
    json = JSON.stringify({ text: masked });
  }
  if (Buffer.byteLength(json) <= 8192) return json;
  const chars = Array.from(json);
  let out = chars.slice(0, 7800).join('');
  while (Buffer.byteLength(`${out}\n…[обрезано]`) > 8192) out = Array.from(out).slice(0, -1).join('');
  return `${out}\n…[обрезано]`;
}
