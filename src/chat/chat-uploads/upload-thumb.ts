/**
 * Миниатюры загрузок пользователя для панели «Медиа/Файлы»
 * (docs/superpowers/specs/2026-11-16-chat-uploads-media-notes-design.md).
 *
 * В отличие от миниатюр файлов ассистента (chat-files/thumbnails.ts: квадрат
 * 384 с обрезкой, публичный бакет, ручка /webhook/chat/thumb) пропорции
 * сохраняются, длинная сторона ≤ 480, а сама миниатюра лежит в ПРИВАТНОМ
 * бакете загрузок рядом с оригиналом и отдаётся только владельцу
 * (GET /webhook/chat-uploads/:id/thumb).
 */

/**
 * export = sharp: require и тип — как в chat-files/thumbnails.ts (там же
 * объяснение, почему не default-импорт и почему типы из lib/index.d.ts).
 * Сам thumbnails.ts не импортируем: он тянет chat-file-store и EventsService.
 */
const sharp = require('sharp') as unknown as typeof import('sharp/lib/index');

/** Длинная сторона миниатюры, px. */
export const UPLOAD_THUMB_MAX_SIDE = 480;

/** Потолок пикселей исходника — как у renderThumb: «бомба» из мелкого файла бросает, а не съедает память. */
const MAX_INPUT_PIXELS = 50_000_000;

/** Ключ миниатюры в бакете загрузок: thumbs/<storage_key>.webp. */
export function uploadThumbKey(storageKey: string): string {
  return `thumbs/${storageKey}.webp`;
}

/**
 * WebP с длинной стороной не больше UPLOAD_THUMB_MAX_SIDE: поворот по EXIF,
 * маленькие картинки не растягиваются, у анимированных — первый кадр.
 * null — не картинка по mime, SVG или любой сбой (битые байты, HEIC без
 * кодека, слишком много пикселей): файл сохраняется и без миниатюры.
 */
export async function makeUploadThumb(buffer: Buffer, mime: string): Promise<Buffer | null> {
  const type = String(mime || '').toLowerCase();
  // SVG — не растр: рендерить его на сервере ради значка панели незачем.
  if (!type.startsWith('image/') || type.startsWith('image/svg')) return null;
  if (!buffer || buffer.length === 0) return null;
  try {
    return await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(UPLOAD_THUMB_MAX_SIDE, UPLOAD_THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
  } catch {
    return null;
  }
}
