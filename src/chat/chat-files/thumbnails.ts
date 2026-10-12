import { createHash } from 'crypto';
// export = sharp: без esModuleInterop только так (default-импорт дал бы undefined).
import sharp = require('sharp');
import { chatFilesBucket } from './chat-file-store';
import { encodeStrict, safeDecode } from './file-meta';

/**
 * Миниатюры картинок для панели «Медиа и файлы»
 * (docs/superpowers/specs/2026-10-12-chat-files-stats-thumbs-design.md, spirits_front).
 */

/** Сторона миниатюры, px: плитка панели ~130 px, экран ×3. */
export const THUMB_SIZE = 384;
/** Публичный бакет с анонимным GetObject и раздачей через /smm-media/ (CSP sandbox). */
export const THUMB_BUCKET = 'linkeon-assets';
export const THUMB_PREFIX = 'thumbs/';
/** Исходник больше — миниатюру не делаем, панель покажет оригинал. */
export const THUMB_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Не больше стольких уменьшений одновременно на процесс. */
export const THUMB_CONCURRENCY = 2;
/** Дольше ждать очереди не стоит: отдаём оригинал. */
export const THUMB_QUEUE_WAIT_MS = 10_000;

const MAX_SRC_LENGTH = 300;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)$/i;

export interface ThumbSource {
  bucket: string;
  key: string;
}

const hasControlChars = (s: string) => [...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

/**
 * Разбор `src` вида `<бакет>/<ключ>`. Разрешены только картинки наших бакетов:
 * сгенерированные (`linkeon-assets/images/…`) и файлы переписки
 * (`linkeon-chat-files/…`, кроме самих миниатюр). Адрес исходника бэк строит
 * сам из бакета и ключа, поэтому через ручку нельзя сходить на чужой хост или
 * во внутреннюю сеть.
 */
export function parseThumbSrc(src: unknown): ThumbSource | null {
  if (typeof src !== 'string' || src.length === 0 || src.length > MAX_SRC_LENGTH) return null;
  if (hasControlChars(src) || src.startsWith('/') || src.includes('\\')) return null;
  const slash = src.indexOf('/');
  if (slash <= 0) return null;
  const bucket = src.slice(0, slash);
  const key = src.slice(slash + 1);
  if (key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  if (!IMAGE_EXT_RE.test(key)) return null;
  if (bucket === THUMB_BUCKET) {
    if (!key.startsWith('images/')) return null;
  } else if (bucket === chatFilesBucket()) {
    if (key.startsWith(THUMB_PREFIX)) return null;
  } else {
    return null;
  }
  return { bucket, key };
}

/** Ключ миниатюры: хеш исходника, без имени файла в адресе. */
export function thumbKeyFor(s: ThumbSource): string {
  return `${THUMB_PREFIX}${createHash('sha1').update(`${s.bucket}/${s.key}`).digest('hex')}.webp`;
}

/** Ключ для публичного адреса: каждый сегмент закодирован (в именах бывают пробелы, скобки, кириллица). */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeStrict).join('/');
}

/**
 * Путь ручки миниатюры для картинки панели, если картинка лежит в наших
 * разрешённых бакетах; иначе undefined — панель покажет оригинал.
 */
export function thumbPathFor(url: string | undefined, publicBaseUrl: string): string | undefined {
  if (!url || !publicBaseUrl || !url.startsWith(`${publicBaseUrl}/`)) return undefined;
  const rest = url.slice(publicBaseUrl.length + 1).split(/[?#]/)[0];
  const src = rest.split('/').map(safeDecode).join('/');
  return parseThumbSrc(src) ? `/webhook/chat/thumb?src=${encodeURIComponent(src)}` : undefined;
}

/** WebP 384×384 с обрезкой по центру; поворот по EXIF; у анимированного GIF — первый кадр. */
export async function renderThumb(source: Buffer): Promise<Buffer> {
  return sharp(source, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
    .webp({ quality: 70 })
    .toBuffer();
}
