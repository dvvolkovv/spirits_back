/**
 * Миниатюры загрузок пользователя для панели «Медиа/Файлы»
 * (docs/superpowers/specs/2026-11-16-chat-uploads-media-notes-design.md).
 *
 * В отличие от миниатюр файлов ассистента (chat-files/thumbnails.ts: квадрат
 * 384 с обрезкой, публичный бакет, ручка /webhook/chat/thumb) пропорции
 * сохраняются, длинная сторона ≤ 480, а сама миниатюра лежит в ПРИВАТНОМ
 * бакете загрузок рядом с оригиналом и отдаётся только владельцу
 * (GET /webhook/chat-uploads/:id/thumb).
 *
 * Миниатюра необязательна: рендер идёт в пути сохранения хода (бюджет
 * CHAT_UPLOADS_SAVE_BUDGET_MS в chat.controller), поэтому работа sharp
 * ограничена — не больше UPLOAD_THUMB_CONCURRENCY рендеров на процесс,
 * место ждём не дольше UPLOAD_THUMB_QUEUE_WAIT_MS, сам конвейер — не дольше
 * UPLOAD_THUMB_TIMEOUT_SECONDS, а все миниатюры одного вызова saveOriginals
 * укладываются в UPLOAD_THUMB_CALL_BUDGET_MS. Не уложились — файл
 * сохраняется без миниатюры.
 */

/**
 * export = sharp: require и тип — как в chat-files/thumbnails.ts (там же
 * объяснение, почему не default-импорт и почему типы из lib/index.d.ts).
 * Сам thumbnails.ts не импортируем: он тянет chat-file-store и EventsService.
 */
const sharp = require('sharp') as unknown as typeof import('sharp/lib/index');

/** Длинная сторона миниатюры, px. */
export const UPLOAD_THUMB_MAX_SIDE = 480;
/** Не больше стольких рендеров одновременно на процесс. */
export const UPLOAD_THUMB_CONCURRENCY = 2;
/** Дольше ждать места не стоит: миниатюра необязательна, файл сохранится и без неё. */
export const UPLOAD_THUMB_QUEUE_WAIT_MS = 2_500;
/** Потолок работы конвейера sharp над одной миниатюрой (sharp .timeout), с. */
export const UPLOAD_THUMB_TIMEOUT_SECONDS = 5;
/**
 * Общий бюджет миниатюр одного вызова saveOriginals, мс: файлы идут по
 * очереди внутри бюджета сохранения хода, и пачка картинок под нагрузкой не
 * должна съесть его целиком. Бюджет кончился — остальные файлы вызова
 * сохраняются без миниатюр.
 */
export const UPLOAD_THUMB_CALL_BUDGET_MS = 8_000;

/** Потолок пикселей исходника — как у renderThumb: «бомба» из мелкого файла бросает, а не съедает память. */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Белый список mime, для которых делается миниатюра. Решение «делать или нет»
 * живёт только здесь: SVG (не растр), BMP и ICO (sharp не читает), HEIC
 * (кодека hevc в сборке sharp нет) и всё прочее идут без миниатюры.
 */
const THUMBNAILABLE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
]);

/**
 * Белый список настоящих форматов (metadata().format): mime присылает
 * клиент, поэтому рендерим только то, что и по байтам — из списка выше.
 * AVIF sharp отдаёт как heif с compression av1; HEIC (hevc) — нет.
 */
const RENDERABLE_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff']);

export type UploadThumbFailure = 'unsupported' | 'pixel_limit' | 'corrupt' | 'timeout' | 'busy';
export type UploadThumbResult = { ok: true; webp: Buffer } | { ok: false; reason: UploadThumbFailure };

/** mime из белого списка (регистр, пробелы и параметры после «;» не важны). */
export function isThumbnailableMime(mime: string): boolean {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return THUMBNAILABLE_MIMES.has(type);
}

/** Ключ миниатюры в бакете загрузок: thumbs/<storage_key>.webp. */
export function uploadThumbKey(storageKey: string): string {
  return `thumbs/${storageKey}.webp`;
}

/**
 * Вид сбоя sharp по тексту ошибки. Сам текст наружу не уходит: в журнал
 * пишется только вид.
 */
export function classifyThumbError(e: unknown): Exclude<UploadThumbFailure, 'busy'> {
  const message = e instanceof Error ? e.message : '';
  if (/pixel limit/i.test(message)) return 'pixel_limit';
  // sharp .timeout(): vips_error("timeout", "%d%% complete").
  if (/\btimeout\b/i.test(message)) return 'timeout';
  if (/unsupported|not been built|no decoding plugin|not a known/i.test(message)) return 'unsupported';
  return 'corrupt';
}

/**
 * Места под рендер (форма — как Slots в chat-files/thumbnail.service.ts):
 * не больше limit одновременно, ждать места — не дольше waitMs. Не дождался —
 * null, а не исключение: миниатюра необязательна.
 */
export class UploadThumbSlots {
  private busy = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  acquire(waitMs: number): Promise<(() => void) | null> {
    if (this.busy < this.limit) {
      this.busy++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve(null);
      }, waitMs);
      this.waiting.push(grant);
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      // Место переходит следующему как есть: busy не меняется.
      const next = this.waiting.shift();
      if (next) next();
      else this.busy--;
    };
  }
}

/** Общие на процесс места под рендер миниатюр загрузок. */
const slots = new UploadThumbSlots(UPLOAD_THUMB_CONCURRENCY);

/**
 * WebP с длинной стороной не больше UPLOAD_THUMB_MAX_SIDE: поворот по EXIF,
 * маленькие картинки не растягиваются, у анимированных — первый кадр,
 * метаданные (EXIF, GPS) в миниатюру не попадают. Никогда не бросает:
 * отказ — { ok: false, reason }, и файл сохраняется без миниатюры.
 * `options` — для тестов: свои места и своё ожидание.
 */
export async function makeUploadThumb(
  buffer: Buffer,
  mime: string,
  options: { slots?: UploadThumbSlots; waitMs?: number } = {},
): Promise<UploadThumbResult> {
  if (!isThumbnailableMime(mime)) return { ok: false, reason: 'unsupported' };
  if (!buffer || buffer.length === 0) return { ok: false, reason: 'corrupt' };

  const release = await (options.slots ?? slots).acquire(options.waitMs ?? UPLOAD_THUMB_QUEUE_WAIT_MS);
  if (!release) return { ok: false, reason: 'busy' };
  try {
    // Настоящий формат по байтам: SVG под видом image/png не рендерим.
    // Глобальный sharp.block не годится — SVG рендерит human-design/bodygraph-png.ts.
    const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    const renderable = meta.format === 'heif'
      ? meta.compression === 'av1'
      : RENDERABLE_FORMATS.has(String(meta.format));
    if (!renderable) return { ok: false, reason: 'unsupported' };

    const webp = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .timeout({ seconds: UPLOAD_THUMB_TIMEOUT_SECONDS })
      .rotate()
      .resize(UPLOAD_THUMB_MAX_SIDE, UPLOAD_THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
    return { ok: true, webp };
  } catch (e) {
    return { ok: false, reason: classifyThumbError(e) };
  } finally {
    release();
  }
}
