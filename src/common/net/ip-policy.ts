// src/common/net/ip-policy.ts
//
// Классификация IP-адресов для защиты от SSRF: куда серверу НЕЛЬЗЯ ходить по
// ссылке, которую выбрал пользователь или модель.
//
// ЗАЧЕМ (безопасность, 26.09.2026)
// ────────────────────────────────
// API живёт на одной машине с Postgres, Redis (6379/6380), Neo4j, MinIO и самим
// собой на 127.0.0.1:3001. Любой fetch по чужой ссылке, который доходит до
// внутреннего адреса, превращает нас в прокси во внутреннюю сеть: ответ часто
// возвращается человеку (маркер {{file:…}} в Telegram шлёт скачанные байты в
// чат, аватар проксируется как есть, ICS разбирается и показывается).
//
// ПОЧЕМУ СВОЙ РАЗБОР, А НЕ net.BlockList
// ─────────────────────────────────────
// BlockList сам сопоставляет IPv4-mapped (::ffff:a.b.c.d) с IPv4-правилами, но
// ничего не знает про NAT64 (64:ff9b::/96) и 6to4 (2002::/16), где IPv4 тоже
// вшит в IPv6. Явный разбор в группы проще проверить тестами по каждому
// диапазону, и в нём видно, что именно считается запретным.
//
// Для IPv6 правило построено как РАЗРЕШАЮЩЕЕ: глобальный юникаст бывает только
// в 2000::/3, всё остальное адресное пространство — служебное (loopback,
// link-local, ULA, multicast, резерв). Запрещающий список для IPv6 пришлось бы
// дописывать при каждом новом RFC, разрешающий закрыт по умолчанию.

import * as net from 'net';

/** Разбор строгой dotted-quad записи в 32-битное число; null — не IPv4. */
export function parseIPv4(input: string): number | null {
  const s = String(input ?? '').trim();
  if (!net.isIPv4(s)) return null;
  const parts = s.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

/**
 * Разбор IPv6 в восемь 16-битных групп. Понимает `::`, хвост в виде IPv4
 * (`::ffff:127.0.0.1`), квадратные скобки и zone id (`fe80::1%eth0`).
 * null — не IPv6.
 */
export function parseIPv6(input: string): number[] | null {
  let s = String(input ?? '').trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;

  // Хвост a.b.c.d превращаем в две шестнадцатеричные группы — дальше разбор общий.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array(missing).fill('0'), ...rest];
  }
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return out.some((g) => Number.isNaN(g)) ? null : out;
}

/** IPv4-диапазоны, куда ходить нельзя: частные, loopback, link-local, служебные, документационные. */
const V4_BLOCKED: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // «этот» хост/сеть; 0.0.0.0 на Linux = локальная машина
  ['10.0.0.0', 8], // частная сеть (сюда же WireGuard 10.10.0.x)
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback: Postgres, Redis, MinIO, сам API
  ['169.254.0.0', 16], // link-local, облачные метаданные 169.254.169.254
  ['172.16.0.0', 12], // частная сеть (docker-мосты)
  ['192.0.0.0', 24], // служебные назначения IETF
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // частная сеть
  ['198.18.0.0', 15], // бенчмарки
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // резерв, включая 255.255.255.255
];

const V4_BLOCKED_PARSED = V4_BLOCKED.map(([base, prefix]) => ({ base: parseIPv4(base)!, prefix }));

function v4InPrefix(ip: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (~0 << (32 - prefix)) >>> 0;
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

export function isBlockedIPv4(ip: number): boolean {
  return V4_BLOCKED_PARSED.some(({ base, prefix }) => v4InPrefix(ip, base, prefix));
}

function embeddedV4(hi: number, lo: number): number {
  return ((hi << 16) >>> 0) + lo;
}

export function isBlockedIPv6(g: number[]): boolean {
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);

  // ::/96 — :: (unspecified), ::1 (loopback) и устаревшие IPv4-compatible
  // (::a.b.c.d). Для чужого сервера ни одна из этих форм не нужна.
  if (zeroUpTo(6)) return true;
  // ::ffff:0:0/96 — IPv4-mapped: ядро отправит пакет на вшитый IPv4.
  if (zeroUpTo(5) && g[5] === 0xffff) return isBlockedIPv4(embeddedV4(g[6], g[7]));
  // ::ffff:0:0:0/96 — IPv4-translated (SIIT), наружу не маршрутизируется.
  if (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return true;
  // 64:ff9b::/96 — NAT64: шлюз пойдёт на вшитый IPv4, проверяем его.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIPv4(embeddedV4(g[6], g[7]));
  }

  // Дальше — только глобальный юникаст 2000::/3; всё прочее (fc00::/7 ULA,
  // fe80::/10 link-local, fec0::/10, ff00::/8 multicast, 64:ff9b:1::/48,
  // 100::/64 и т.д.) запрещено этой строкой.
  if ((g[0] & 0xe000) !== 0x2000) return true;

  // Служебные куски внутри 2000::/3.
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23: Teredo, ORCHID, бенчмарки
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 документация
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true; // 3fff::/20 документация (RFC 9637)
  // 2002::/16 — 6to4: IPv4 вшит в группы 1–2.
  if (g[0] === 0x2002) return isBlockedIPv4(embeddedV4(g[1], g[2]));
  return false;
}

/**
 * true — адрес внутренний/служебный, ходить туда нельзя.
 * Нераспознанная строка тоже true: закрыто по умолчанию.
 */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return isBlockedIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6 !== null) return isBlockedIPv6(v6);
  return true;
}

/**
 * Каноническая запись адреса для сравнения множеств: IPv4 как есть,
 * IPv4-mapped — как вшитый IPv4, прочий IPv6 — восемь групп без сжатия.
 * null — не адрес.
 */
export function canonicalIp(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return [v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join('.');
  const g = parseIPv6(ip);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return canonicalIp(`${g[6] >>> 8}.${g[6] & 255}.${g[7] >>> 8}.${g[7] & 255}`);
  return g.map((x) => x.toString(16)).join(':');
}

/** CIDR вида `a.b.c.d/nn` или `x:y::/nn` (без длины — один адрес). null — не разобрали. */
export interface Cidr {
  family: 4 | 6;
  bits: number[]; // IPv4: [ip], IPv6: восемь групп
  prefix: number;
}

export function parseCidr(input: string): Cidr | null {
  const [addr, len] = String(input ?? '').trim().split('/');
  const v4 = parseIPv4(addr);
  if (v4 !== null) {
    const prefix = len === undefined ? 32 : Number(len);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return { family: 4, bits: [v4], prefix };
  }
  const v6 = parseIPv6(addr);
  if (v6 !== null) {
    const prefix = len === undefined ? 128 : Number(len);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
    return { family: 6, bits: v6, prefix };
  }
  return null;
}

export function ipInCidr(ip: string, cidr: Cidr): boolean {
  if (cidr.family === 4) {
    const v4 = parseIPv4(canonicalIp(ip) ?? '');
    return v4 !== null && v4InPrefix(v4, cidr.bits[0], cidr.prefix);
  }
  const g = parseIPv6(ip);
  if (!g) return false;
  let left = cidr.prefix;
  for (let i = 0; i < 8 && left > 0; i++) {
    const take = Math.min(16, left);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((g[i] & mask) !== (cidr.bits[i] & mask)) return false;
    left -= take;
  }
  return true;
}
