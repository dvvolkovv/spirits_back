// src/common/net/own-media.ts
//
// Скачать картинку/файл по ссылке, которая МОЖЕТ оказаться нашей же.
//
// Большинство ссылок, которые приходят в правку картинок, в маркеры Telegram
// и в аватары, — наши собственные: сгенерированное лежит в MinIO
// (MINIO_PUBLIC_URL/linkeon-assets/…), старое — в public/ под /static/. Ходить
// за ними по HTTP через наш же домен — лишний круг через прокси Selectel, а
// главное, после защиты от SSRF это может не пройти: домен изнутри вполне
// может резолвиться во внутренний адрес. Поэтому:
//   • /static/… (относительно или на нашем домене) — читаем файл из public/
//     напрямую, с проверкой, что путь не выходит за public/;
//   • MINIO_PUBLIC_URL/… — safeGet сам перепишет на внутренний MinIO (см. шапку
//     safe-fetch.ts);
//   • всё остальное — safeGet с полной проверкой каждого шага.
//
// Свои домены — только точные origin из BACKEND_URL / PUBLIC_BASE_URL (по
// умолчанию https://my.linkeon.io), никаких масок и поддоменов.

import * as fs from 'fs';
import * as path from 'path';
import { assertPublicUrl, ownStorageRoute, safeGet, UnsafeUrlError, UrlPolicy } from './safe-fetch';

const DEFAULT_BASE = 'https://my.linkeon.io';

/** Базовый адрес своего сайта для относительных ссылок вида /static/… и /smm-media/…. */
export function ownBaseUrl(): string {
  return (process.env.BACKEND_URL || process.env.PUBLIC_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

function ownOrigins(): Set<string> {
  const out = new Set<string>();
  for (const raw of [process.env.BACKEND_URL, process.env.PUBLIC_BASE_URL, DEFAULT_BASE]) {
    if (!raw) continue;
    try { out.add(new URL(raw).origin); } catch { /* кривое окружение — просто не наш origin */ }
  }
  return out;
}

/** Корень, который nginx отдаёт как /static/. Тот же, что у video.service. */
export function publicDir(): string {
  return process.env.PUBLIC_DIR ? path.resolve(process.env.PUBLIC_DIR) : path.resolve(process.cwd(), 'public');
}

/** '/x' → '<свой сайт>/x'; остальное как есть ('//host' — это чужой хост, не относительный путь). */
export function toAbsoluteUrl(raw: string): string {
  const s = String(raw ?? '').trim();
  return s.startsWith('/') && !s.startsWith('//') ? `${ownBaseUrl()}${s}` : s;
}

export interface OwnStaticFile {
  /** Абсолютный путь внутри public/. */
  file: string;
  /** Та же ссылка в публичном виде. */
  url: string;
}

/**
 * Если ссылка ведёт в наш /static/ — путь к файлу внутри public/. null — не
 * наш /static/. UnsafeUrlError — наш /static/, но путь пытается выйти наружу
 * (`..%2f`, скрытые файлы, обратные слэши).
 *
 * Раньше здесь были голые `path.join(cwd, 'public', url.replace('/static/', ''))`:
 * `/static/../../../etc/passwd` честно превращался в /etc/passwd.
 */
export function ownStaticPath(raw: string): OwnStaticFile | null {
  const s = String(raw ?? '').trim();
  let u: URL;
  try {
    u = s.startsWith('/') && !s.startsWith('//') ? new URL(s, `${ownBaseUrl()}/`) : new URL(s);
  } catch {
    return null;
  }
  if (!ownOrigins().has(u.origin) || !u.pathname.startsWith('/static/')) return null;

  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname.slice('/static/'.length));
  } catch {
    throw new UnsafeUrlError('некорректный путь к файлу');
  }
  const segments = rel.split('/');
  const bad = segments.some((seg) => !seg || seg.startsWith('.') || seg.includes('\\') || seg.includes('\0'));
  if (!rel || bad) throw new UnsafeUrlError('некорректный путь к файлу');

  const root = publicDir();
  const file = path.resolve(root, ...segments);
  if (!file.startsWith(root + path.sep)) throw new UnsafeUrlError('некорректный путь к файлу');
  return { file, url: `${u.origin}${u.pathname}` };
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
};

function contentTypeByName(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

export interface MediaBytes {
  data: Buffer;
  /** Content-Type ответа; для своих файлов — по расширению. Пустая строка — не сообщили. */
  contentType: string;
  finalUrl: string;
}

export interface MediaFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Разрешить http:// для чужих ссылок (свои читаются в обход). */
  allowHttp?: boolean;
}

// Граница — лексическая (path.resolve в ownStaticPath), как у nginx для
// /static/: симлинки внутри public/ кладёт только наш же код или админ, и
// наружу через nginx они видны точно так же. realpath здесь сломал бы
// законный public/, если какой-то его подкаталог окажется симлинком.
async function readOwnStatic(f: OwnStaticFile, maxBytes: number): Promise<MediaBytes> {
  const st = await fs.promises.stat(f.file).catch(() => null);
  if (!st || !st.isFile()) throw Object.assign(new Error('файл не найден на сервере'), { code: 'ENOENT' });
  if (st.size > maxBytes) {
    throw Object.assign(new Error(`ответ больше допустимого (${maxBytes} байт)`), { code: 'ERR_TOO_LARGE' });
  }
  return { data: await fs.promises.readFile(f.file), contentType: contentTypeByName(f.file), finalUrl: f.url };
}

/**
 * Байты по ссылке пользователя/модели: своё — напрямую, чужое — через safeGet.
 * Бросает UnsafeUrlError, если ссылка ведёт во внутреннюю сеть.
 */
export async function fetchMediaBytes(raw: string, opts: MediaFetchOptions): Promise<MediaBytes> {
  const own = ownStaticPath(raw);
  if (own) return readOwnStatic(own, opts.maxBytes);
  const r = await safeGet(toAbsoluteUrl(raw), {
    maxBytes: opts.maxBytes,
    timeoutMs: opts.timeoutMs,
    allowHttp: opts.allowHttp,
    responseType: 'arraybuffer',
  });
  return { data: r.data, contentType: r.headers['content-type'] || '', finalUrl: r.finalUrl };
}

/**
 * Проверка без скачивания — чтобы отказать ДО списания токенов, а не после.
 * Своё (/static/, MinIO) пропускается; чужое проходит синтаксис и DNS.
 * Безопасность этим не обеспечивается — её даёт проверка в момент скачивания.
 */
export async function assertFetchableMedia(raw: string, policy: UrlPolicy = {}): Promise<void> {
  if (ownStaticPath(raw)) return;
  const abs = toAbsoluteUrl(raw);
  try {
    if (ownStorageRoute(new URL(abs))) return;
  } catch {
    // некорректную ссылку разберёт assertPublicUrl и назовёт причину
  }
  await assertPublicUrl(abs, policy);
}
