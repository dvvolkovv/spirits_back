// src/common/net/safe-fetch.ts
//
// Скачивание по ЧУЖОЙ ссылке — выбранной пользователем, записанной им в БД или
// выданной моделью — без риска уйти во внутреннюю сеть (SSRF).
//
// Что проверяется на КАЖДОМ шаге, включая каждый редирект:
//   1. Схема: https; http — только если вызывающий явно разрешил (ICS, webcal).
//   2. Логин:пароль в самой ссылке — нельзя (свои креды вызывающие шлют заголовком).
//   3. Порт: только 80/443, любой — только с allowAnyPort (самостоятельно
//      поднятые календарные серверы).
//   4. Имя: localhost, *.localhost, *.internal, *.local — нельзя; IP-литерал
//      проверяется по диапазонам ip-policy (WHATWG URL заранее приводит
//      2130706433, 0x7f.1, 017700000001 к 127.0.0.1 — проверяем уже его).
//   5. DNS: все A/AAAA имени; если ХОТЬ ОДИН адрес внутренний — отказ.
//
// ПИННИНГ ПРОТИВ DNS REBINDING
// ────────────────────────────
// Проверить имя и отдать его HTTP-клиенту мало: клиент резолвит заново, и
// злой DNS с TTL=0 на втором запросе отдаст 127.0.0.1. Поэтому соединение идёт
// через Agent со своим `lookup`, который НЕ ходит в DNS, а возвращает ровно те
// адреса, что мы проверили. Имя в запросе остаётся исходным: для https это
// значит, что SNI и проверка сертификата идут по настоящему хосту.
//
// РЕДИРЕКТЫ — ТОЛЬКО РУКАМИ
// ─────────────────────────
// axios вызывается с maxRedirects: 0, Location разбирается относительно
// текущего адреса и проходит ту же проверку, что и первый. Иначе публичная
// ссылка с 302 на http://127.0.0.1:6379 проходила бы любую предварительную
// проверку.
//
// СВОЁ ХРАНИЛИЩЕ
// ──────────────
// Наши же картинки (сгенерированные, загруженные пользователем) лежат в MinIO
// и имеют публичный адрес MINIO_PUBLIC_URL/<bucket>/<key> — nginx проксирует
// его на MINIO_ENDPOINT. Такие ссылки не идут наружу через прокси Selectel, а
// переписываются на внутренний MINIO_ENDPOINT тем же путём и читаются
// АНОНИМНО: права решает политика бакета MinIO — ровно то, что видит любой
// человек в интернете через nginx. Без query-строки (никаких ?policy, ?acl,
// листингов) и без заголовков вызывающего. Это единственное место, где запрос
// уходит на внутренний адрес, и адрес этот берётся из окружения, а не из ссылки.

import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import { Readable, Transform, pipeline } from 'stream';
import axios from 'axios';
import { canonicalIp, ipInCidr, isBlockedAddress, parseCidr, Cidr } from './ip-policy';

export interface UrlPolicy {
  /** Разрешить http:// (по умолчанию только https). */
  allowHttp?: boolean;
  /** Разрешить любой явный порт (по умолчанию только 80 и 443). */
  allowAnyPort?: boolean;
  /** Разрешить логин:пароль в самой ссылке (по умолчанию нельзя). */
  allowCredentials?: boolean;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface PublicTarget {
  url: URL;
  /** Имя хоста без скобок и завершающей точки, в нижнем регистре. */
  hostname: string;
  /** Проверенные адреса — на них и только на них пойдёт соединение. */
  addresses: ResolvedAddress[];
}

/**
 * Отказ по соображениям безопасности. Сообщение короткое и по-русски: оно
 * доходит до человека (сообщение в Telegram, ошибка инструмента модели,
 * ответ API), поэтому внутренних подробностей (какой IP вернул DNS) в нём нет.
 */
export class UnsafeUrlError extends Error {
  readonly code = 'UNSAFE_URL';
  constructor(reason: string) {
    super(`ссылка не принята: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

export function isUnsafeUrlError(e: unknown): e is UnsafeUrlError {
  const x = e as any;
  return x instanceof UnsafeUrlError || x?.code === 'UNSAFE_URL' || x?.cause?.code === 'UNSAFE_URL';
}

const REASON_INTERNAL = 'адрес ведёт во внутреннюю сеть';

// ───────────────────────── зависимости (подменяются в тестах) ─────────────────────────

export interface SafeFetchDeps {
  /** Все адреса имени. По умолчанию dns.lookup (учитывает /etc/hosts, как и сам HTTP-клиент). */
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  /** true — ходить на адрес нельзя. */
  isBlocked(ip: string): boolean;
  /**
   * Срок на DNS в assertPublicUrl. safeGet и так ограничен общим сроком, но
   * push и Exchange зовут assertPublicUrl напрямую, а медленный резолвер чужого
   * имени иначе держал бы их на таймаутах ОС (у push — на каждой подписке цикла).
   */
  dnsTimeoutMs: number;
}

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const list = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return list.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

// Адреса собственных интерфейсов. Наш публичный IP — не «внутренний» по
// диапазонам, но запрос на него приходит в ту же машину: сервис, слушающий
// 0.0.0.0 (MinIO, Neo4j, сам API на 3001), доступен через него изнутри, даже
// если снаружи порт закрыт фаерволом.
let localAddrCache: { at: number; set: Set<string> } | null = null;
const LOCAL_ADDR_TTL_MS = 60_000;

function localInterfaceAddresses(): Set<string> {
  const now = Date.now();
  if (localAddrCache && now - localAddrCache.at < LOCAL_ADDR_TTL_MS) return localAddrCache.set;
  const set = new Set<string>();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        const c = canonicalIp(a.address);
        if (c) set.add(c);
      }
    }
  } catch {
    // Без списка интерфейсов остаются диапазоны — это не повод падать.
  }
  localAddrCache = { at: now, set };
  return set;
}

// Дополнительные запреты из окружения: SSRF_EXTRA_BLOCKED_CIDRS="1.2.3.4/32,2a01::/32".
// Нужны для публичных адресов, которые доверяют НАШЕМУ IP (машины продуктов,
// туннели), — по диапазонам их не отличить от интернета.
let extraCidrCache: { raw: string; list: Cidr[] } | null = null;

function extraBlockedCidrs(): Cidr[] {
  const raw = process.env.SSRF_EXTRA_BLOCKED_CIDRS || '';
  if (extraCidrCache && extraCidrCache.raw === raw) return extraCidrCache.list;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean).map(parseCidr).filter((c): c is Cidr => !!c);
  extraCidrCache = { raw, list };
  return list;
}

function defaultIsBlocked(ip: string): boolean {
  if (isBlockedAddress(ip)) return true;
  const c = canonicalIp(ip);
  if (c && localInterfaceAddresses().has(c)) return true;
  return extraBlockedCidrs().some((cidr) => ipInCidr(ip, cidr));
}

const defaultDeps: SafeFetchDeps = { resolve: systemResolve, isBlocked: defaultIsBlocked, dnsTimeoutMs: 10_000 };
let deps: SafeFetchDeps = defaultDeps;

/** Только для тестов: подменить DNS и классификатор адресов. null — вернуть настоящие. Сбрасывает кеши. */
export function __setSafeFetchDepsForTests(d: Partial<SafeFetchDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
  localAddrCache = null;
  extraCidrCache = null;
}

// ───────────────────────── проверка ссылки ─────────────────────────

/** Имя хоста для сравнений: нижний регистр, без [скобок] IPv6 и без завершающей точки. */
export function normalizeHostname(host: string): string {
  let h = String(host ?? '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h.replace(/\.+$/, '');
}

function isForbiddenName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local');
}

/**
 * Проверка без сети: схема, userinfo, порт, имя и IP-литерал.
 * Возвращает разобранный URL; бросает UnsafeUrlError.
 */
export function checkUrlSyntax(raw: string, policy: UrlPolicy = {}): URL {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new UnsafeUrlError('некорректный адрес');
  }
  if (u.protocol !== 'https:' && !(policy.allowHttp && u.protocol === 'http:')) {
    throw new UnsafeUrlError(policy.allowHttp ? 'поддерживаются только http(s)-ссылки' : 'поддерживаются только https-ссылки');
  }
  if ((u.username || u.password) && !policy.allowCredentials) {
    throw new UnsafeUrlError('логин и пароль в самой ссылке не допускаются');
  }
  // Хост раньше порта: на http://127.0.0.1:6379 причина — внутренняя сеть, а не порт.
  const host = normalizeHostname(u.hostname);
  if (!host) throw new UnsafeUrlError('некорректный адрес');
  if (net.isIP(host)) {
    if (deps.isBlocked(host)) throw new UnsafeUrlError(REASON_INTERNAL);
  } else if (isForbiddenName(host)) {
    throw new UnsafeUrlError(REASON_INTERNAL);
  }
  // WHATWG убирает порт по умолчанию схемы, так что пустой port — это 443/80.
  if (u.port && !policy.allowAnyPort && u.port !== '80' && u.port !== '443') {
    throw new UnsafeUrlError('нестандартный порт');
  }
  return u;
}

function dnsError(hostname: string, cause?: any): Error {
  const e: any = new Error(`адрес ${hostname} не найден`);
  e.code = cause?.code || 'ENOTFOUND';
  return e;
}

/**
 * Полная проверка: синтаксис + DNS. Отказ, если ЛЮБОЙ из адресов имени
 * внутренний (иначе клиент мог бы выбрать именно его). Возвращает адреса,
 * на которые потом пиннится соединение.
 */
export async function assertPublicUrl(raw: string, policy: UrlPolicy = {}): Promise<PublicTarget> {
  const url = checkUrlSyntax(raw, policy);
  const hostname = normalizeHostname(url.hostname);
  const fam = net.isIP(hostname);
  if (fam) return { url, hostname, addresses: [{ address: hostname, family: fam === 6 ? 6 : 4 }] };

  let addresses: ResolvedAddress[];
  let timer: NodeJS.Timeout | undefined;
  try {
    addresses = await Promise.race([
      deps.resolve(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('DNS не ответил'), { code: 'ETIMEOUT' })), deps.dnsTimeoutMs);
      }),
    ]);
  } catch (e: any) {
    throw dnsError(hostname, e);
  } finally {
    clearTimeout(timer);
  }
  if (!addresses || addresses.length === 0) throw dnsError(hostname);
  if (addresses.some((a) => deps.isBlocked(a.address))) throw new UnsafeUrlError(REASON_INTERNAL);
  return { url, hostname, addresses };
}

// ───────────────────────── пиннинг соединения ─────────────────────────

/**
 * `lookup` для net/tls: отдаёт только заранее проверенные адреса и только для
 * проверенного имени. В DNS не ходит — в этом весь смысл.
 */
export function pinnedLookup(hostname: string, addresses: ResolvedAddress[]) {
  const expected = normalizeHostname(hostname);
  return (host: string, options: any, callback?: any): void => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (normalizeHostname(host) !== expected) {
      process.nextTick(() => callback(new UnsafeUrlError(REASON_INTERNAL)));
      return;
    }
    const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
    const list = family ? addresses.filter((a) => a.family === family) : addresses;
    if (list.length === 0) {
      process.nextTick(() => callback(dnsError(host)));
      return;
    }
    if (options?.all) {
      process.nextTick(() => callback(null, list.map((a) => ({ address: a.address, family: a.family }))));
    } else {
      process.nextTick(() => callback(null, list[0].address, list[0].family));
    }
  };
}

/**
 * Agent, который умеет соединяться только с проверенным хостом. Кроме
 * `lookup` проверяем и само имя в createConnection: для IP-литерала node в
 * lookup не ходит вовсе, и без этой проверки расхождение разборщиков URL
 * (наш WHATWG против чужого url.parse) дало бы соединение мимо проверки.
 */
export function pinnedAgent(protocol: string, hostname: string, addresses: ResolvedAddress[]): http.Agent {
  const lookup = pinnedLookup(hostname, addresses);
  const agent: any = protocol === 'https:'
    ? new https.Agent({ keepAlive: false, lookup } as any)
    : new http.Agent({ keepAlive: false, lookup } as any);
  const expected = normalizeHostname(hostname);
  const create = agent.createConnection.bind(agent);
  agent.createConnection = (options: any, cb: any) => {
    const target = normalizeHostname(options?.host ?? options?.hostname ?? '');
    if (target !== expected) {
      process.nextTick(() => cb(new UnsafeUrlError(REASON_INTERNAL)));
      return undefined;
    }
    return create(options, cb);
  };
  return agent;
}

// ───────────────────────── своё хранилище ─────────────────────────

/**
 * Ссылка на наш MinIO (MINIO_PUBLIC_URL/<bucket>/<key>) → тот же объект на
 * внутреннем MINIO_ENDPOINT. null — ссылка не наша или окружение не задано.
 * Путь берётся уже нормализованным WHATWG (точки-сегменты свёрнуты), так что
 * выйти `../` за префикс нельзя: такая ссылка просто перестаёт быть «нашей».
 */
export function ownStorageRoute(url: URL): URL | null {
  const pub = process.env.MINIO_PUBLIC_URL;
  const internal = process.env.MINIO_ENDPOINT;
  if (!pub || !internal) return null;
  let pubUrl: URL;
  let internalUrl: URL;
  try {
    pubUrl = new URL(pub);
    internalUrl = new URL(internal);
  } catch {
    return null;
  }
  if (url.origin !== pubUrl.origin || url.username || url.password) return null;
  const prefix = `${pubUrl.pathname.replace(/\/+$/, '')}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const rest = url.pathname.slice(prefix.length);
  const [bucket, ...keyParts] = rest.split('/');
  // Нужны и бакет, и ключ: без ключа это листинг бакета, без бакета — список
  // бакетов; «minio» — служебные пути самого MinIO (health, metrics), не бакет.
  if (!bucket || keyParts.join('/') === '' || bucket.toLowerCase() === 'minio') return null;
  const out = new URL(internalUrl.href);
  out.pathname = `${internalUrl.pathname.replace(/\/+$/, '')}/${rest}`;
  out.search = '';
  out.hash = '';
  return out;
}

// ───────────────────────── скачивание ─────────────────────────

export const SAFE_FETCH_DEFAULT_MAX_REDIRECTS = 3;

export interface SafeGetOptions extends UrlPolicy {
  /** Потолок тела ответа (после распаковки gzip/br). */
  maxBytes: number;
  /** Общий срок на всё: DNS, все редиректы и чтение тела (для stream — до его конца). */
  timeoutMs: number;
  headers?: Record<string, string>;
  responseType?: 'arraybuffer' | 'stream' | 'text';
  /** Сколько редиректов пройти, каждый с полной проверкой. По умолчанию 3. */
  maxRedirects?: number;
  /** Какие коды считать успехом. По умолчанию 2xx; остальное — ошибка, как у axios. */
  validateStatus?: (status: number) => boolean;
}

export interface SafeResponse<T> {
  status: number;
  /** Заголовки ответа, имена в нижнем регистре. */
  headers: Record<string, string>;
  data: T;
  /** Адрес после всех редиректов (публичный, даже если читали из своего MinIO). */
  finalUrl: string;
}

function tooLarge(maxBytes: number): Error {
  const e: any = new Error(`ответ больше допустимого (${maxBytes} байт)`);
  e.code = 'ERR_TOO_LARGE';
  return e;
}

function timeoutError(ms: number): Error {
  const e: any = new Error(`превышено время ожидания (${Math.round(ms / 1000)} с)`);
  e.code = 'ETIMEDOUT';
  return e;
}

function httpError(status: number, headers: Record<string, string>): Error {
  const e: any = new Error(`сервер ответил кодом ${status}`);
  e.code = 'ERR_BAD_RESPONSE';
  e.response = { status, headers };
  return e;
}

function plainHeaders(h: any): Record<string, string> {
  const src = h && typeof h.toJSON === 'function' ? h.toJSON() : h || {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function withDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function readLimited(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(e);
    };
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) return fail(tooLarge(maxBytes));
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    stream.on('error', (e) => fail(e));
    stream.on('close', () => fail(new Error('соединение оборвалось')));
  });
}

function limitStream(src: Readable, maxBytes: number, onDone: () => void): Readable {
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) return cb(tooLarge(maxBytes));
      cb(null, chunk);
    },
  });
  pipeline(src, limiter, () => onDone());
  return limiter;
}

function discard(stream: any): void {
  try { stream?.destroy?.(); } catch { /* ignore */ }
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

interface Hop {
  /** Адрес шага, как его видит вызывающий (для редиректов и finalUrl). */
  url: URL;
  /** Куда реально идёт запрос: тот же адрес или внутренний MinIO. */
  requestUrl: string;
  agent?: http.Agent;
  internal: boolean;
}

async function prepareHop(raw: string, policy: UrlPolicy): Promise<Hop> {
  let parsed: URL | null = null;
  try { parsed = new URL(String(raw ?? '').trim()); } catch { /* разберёт checkUrlSyntax ниже */ }
  const own = parsed ? ownStorageRoute(parsed) : null;
  if (own) return { url: parsed, requestUrl: own.href, internal: true };
  const t = await assertPublicUrl(raw, policy);
  return { url: t.url, requestUrl: t.url.href, agent: pinnedAgent(t.url.protocol, t.hostname, t.addresses), internal: false };
}

/**
 * GET по чужой ссылке с проверкой каждого шага. Семантика ошибок как у axios:
 * не-2xx (или что не прошло validateStatus) — исключение с `response.status`.
 * Отказ по безопасности — UnsafeUrlError, запрос при этом не уходит.
 */
export async function safeGet(url: string, opts: SafeGetOptions & { responseType: 'text' }): Promise<SafeResponse<string>>;
export async function safeGet(url: string, opts: SafeGetOptions & { responseType: 'stream' }): Promise<SafeResponse<Readable>>;
export async function safeGet(url: string, opts: SafeGetOptions): Promise<SafeResponse<Buffer>>;
export async function safeGet(url: string, opts: SafeGetOptions): Promise<SafeResponse<any>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(timeoutError(opts.timeoutMs)), opts.timeoutMs);
  let timerOwnedByStream = false;
  const maxRedirects = opts.maxRedirects ?? SAFE_FETCH_DEFAULT_MAX_REDIRECTS;
  const okStatus = opts.validateStatus ?? ((s: number) => s >= 200 && s < 300);
  const policy: UrlPolicy = { allowHttp: opts.allowHttp, allowAnyPort: opts.allowAnyPort, allowCredentials: opts.allowCredentials };

  try {
    let current = url;
    let headers: Record<string, string> = { ...(opts.headers || {}) };
    let prevOrigin: string | null = null;
    for (let hop = 0; ; hop++) {
      const h = await withDeadline(prepareHop(current, policy), ctl.signal);
      // Заголовки вызывающего (вдруг там Authorization) на чужой origin не несём.
      if (prevOrigin !== null && prevOrigin !== h.url.origin) headers = {};

      const resp = await axios.request({
        url: h.requestUrl,
        method: 'GET',
        // Во внутренний MinIO — анонимно и без чужих заголовков.
        headers: h.internal ? {} : headers,
        responseType: 'stream',
        maxRedirects: 0,
        proxy: false, // HTTP(S)_PROXY из окружения увёл бы запрос мимо пиннинга
        httpAgent: h.agent,
        httpsAgent: h.agent,
        validateStatus: () => true,
        signal: ctl.signal,
        decompress: true,
      });
      const status = resp.status;
      const respHeaders = plainHeaders(resp.headers);

      if (REDIRECT_CODES.has(status) && respHeaders.location) {
        discard(resp.data);
        if (h.internal) throw new Error('хранилище ответило перенаправлением');
        if (hop >= maxRedirects) throw new Error('слишком много перенаправлений');
        prevOrigin = h.url.origin;
        try {
          current = new URL(respHeaders.location, h.url).href;
        } catch {
          throw new UnsafeUrlError('некорректный адрес перенаправления');
        }
        continue;
      }

      if (!okStatus(status)) {
        discard(resp.data);
        throw httpError(status, respHeaders);
      }
      const declared = Number(respHeaders['content-length']);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        discard(resp.data);
        throw tooLarge(opts.maxBytes);
      }

      const finalUrl = h.url.href;
      if (opts.responseType === 'stream') {
        timerOwnedByStream = true;
        const data = limitStream(resp.data, opts.maxBytes, () => clearTimeout(timer));
        return { status, headers: respHeaders, data, finalUrl };
      }
      const buf = await readLimited(resp.data, opts.maxBytes);
      const data = opts.responseType === 'text' ? buf.toString('utf8').replace(/^﻿/, '') : buf;
      return { status, headers: respHeaders, data, finalUrl };
    }
  } catch (e: any) {
    // Без type guard'ов: на `any` они сужают тип до never, и tsc это ловит,
    // а ts-jest (isolatedModules) — нет.
    const err: any = e;
    if (err instanceof UnsafeUrlError) throw err;
    if (err?.code === 'UNSAFE_URL' || err?.cause?.code === 'UNSAFE_URL') {
      // axios оборачивает ошибку Agent'а в AxiosError — отдаём исходную.
      throw err.cause instanceof UnsafeUrlError ? err.cause : new UnsafeUrlError(REASON_INTERNAL);
    }
    if (ctl.signal.aborted) throw ctl.signal.reason;
    throw err;
  } finally {
    if (!timerOwnedByStream) clearTimeout(timer);
  }
}
