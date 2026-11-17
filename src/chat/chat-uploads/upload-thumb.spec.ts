import sharp = require('sharp');
import {
  UPLOAD_THUMB_CALL_BUDGET_MS,
  UPLOAD_THUMB_MAX_SIDE,
  UPLOAD_THUMB_QUEUE_WAIT_MS,
  UploadThumbSlots,
  classifyThumbError,
  isThumbnailableMime,
  makeUploadThumb,
  uploadThumbKey,
} from './upload-thumb';

/** Синтетическая однотонная картинка — без единого байта реальных данных. */
const image = (width: number, height: number, background = '#3366ff') =>
  sharp({ create: { width, height, channels: 3, background } });

/** Успешный результат или падение теста с причиной отказа. */
async function webpOf(buffer: Buffer, mime: string): Promise<Buffer> {
  const result = await makeUploadThumb(buffer, mime);
  if (!result.ok) throw new Error(`ожидалась миниатюра, получен отказ: ${result.reason}`);
  return result.webp;
}

describe('uploadThumbKey', () => {
  it('thumbs/<storage_key>.webp — ключ оригинала с префиксом и суффиксом', () => {
    expect(uploadThumbKey('6eb9089f-0000-4000-8000-000000000000/кот (1).png')).toBe(
      'thumbs/6eb9089f-0000-4000-8000-000000000000/кот (1).png.webp',
    );
  });
});

describe('isThumbnailableMime', () => {
  it.each([
    ['image/jpeg'], ['image/png'], ['image/webp'], ['image/gif'], ['image/avif'], ['image/tiff'],
    ['IMAGE/JPEG'], [' image/png '], ['image/jpeg; charset=binary'],
  ])('"%s" — да', (mime) => {
    expect(isThumbnailableMime(mime)).toBe(true);
  });

  it.each([
    ['image/svg+xml'], ['image/bmp'], ['image/x-icon'], ['image/vnd.microsoft.icon'], ['image/heic'],
    ['image/heif'], ['image/jpeg2000'], ['application/pdf'], ['video/mp4'], ['application/octet-stream'], [''],
  ])('"%s" — нет', (mime) => {
    expect(isThumbnailableMime(mime)).toBe(false);
  });

  it('undefined и null — нет, без исключения', () => {
    expect(isThumbnailableMime(undefined as unknown as string)).toBe(false);
    expect(isThumbnailableMime(null as unknown as string)).toBe(false);
  });
});

describe('makeUploadThumb', () => {
  it('длинная сторона миниатюры — 480 px', () => {
    expect(UPLOAD_THUMB_MAX_SIDE).toBe(480);
  });

  it('бюджет миниатюр на один вызов saveOriginals — 8 с, место ждём не дольше 2,5 с', () => {
    expect(UPLOAD_THUMB_CALL_BUDGET_MS).toBe(8_000);
    expect(UPLOAD_THUMB_QUEUE_WAIT_MS).toBe(2_500);
  });

  it('PNG 1000×600 → WebP 480×288 (пропорции сохранены)', async () => {
    const meta = await sharp(await webpOf(await image(1000, 600).png().toBuffer(), 'image/png')).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([480, 288]);
  });

  it('JPEG 600×1000 (портрет) → WebP 288×480', async () => {
    const meta = await sharp(await webpOf(await image(600, 1000).jpeg().toBuffer(), 'image/jpeg')).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([288, 480]);
  });

  it('маленькая картинка не растягивается', async () => {
    const meta = await sharp(await webpOf(await image(200, 100).png().toBuffer(), 'image/png')).metadata();
    expect([meta.width, meta.height]).toEqual([200, 100]);
  });

  it('mime в верхнем регистре — тоже картинка', async () => {
    const result = await makeUploadThumb(await image(1000, 600).jpeg().toBuffer(), 'IMAGE/JPEG');
    expect(result.ok).toBe(true);
  });

  it('EXIF orientation 6: JPEG 1000×600 «на боку» → WebP 288×480, EXIF в миниатюре нет', async () => {
    const rotated = await image(1000, 600).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(rotated).metadata()).orientation).toBe(6); // фикстура действительно с поворотом

    const meta = await sharp(await webpOf(rotated, 'image/jpeg')).metadata();
    expect([meta.width, meta.height]).toEqual([288, 480]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('анимированный GIF → первый кадр, без анимации', async () => {
    const red = await image(100, 60, '#ff0000').png().toBuffer();
    const blue = await image(100, 60, '#0000ff').png().toBuffer();
    const gif = await sharp([red, blue], { join: { animated: true } } as any).gif().toBuffer();
    expect((await sharp(gif).metadata()).pages).toBe(2); // фикстура действительно из двух кадров

    const webp = await webpOf(gif, 'image/gif');
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([100, 60]);
    expect(meta.pages ?? 1).toBe(1);
    const { dominant } = await sharp(webp).stats();
    expect(dominant.r).toBeGreaterThan(200);
    expect(dominant.b).toBeLessThan(50);
  });

  it('AVIF — миниатюра есть', async () => {
    const result = await makeUploadThumb(await image(300, 200).avif().toBuffer(), 'image/avif');
    expect(result.ok).toBe(true);
  });

  it.each([['application/pdf'], ['video/mp4'], ['image/svg+xml'], ['image/heic'], ['']])(
    'mime "%s" — unsupported, даже если байты — картинка',
    async (mime) => {
      const png = await image(1000, 600).png().toBuffer();
      await expect(makeUploadThumb(png, mime)).resolves.toEqual({ ok: false, reason: 'unsupported' });
    },
  );

  it('байты SVG под видом image/png — unsupported (решает настоящий формат, не mime)', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#3366ff"/></svg>',
    );
    await expect(makeUploadThumb(svg, 'image/png')).resolves.toEqual({ ok: false, reason: 'unsupported' });
  });

  it('больше 50 млн пикселей — pixel_limit', async () => {
    // Однотонный одноканальный PNG 7072×7072 (50 013 184 px) весит ~150 КБ.
    const side = 7072;
    const bomb = await sharp(Buffer.alloc(side * side), { raw: { width: side, height: side, channels: 1 } })
      .png()
      .toBuffer();
    await expect(makeUploadThumb(bomb, 'image/png')).resolves.toEqual({ ok: false, reason: 'pixel_limit' });
  });

  it('обрезанный JPEG — corrupt, без исключения', async () => {
    const jpeg = await image(1000, 600).jpeg().toBuffer();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 2));
    await expect(makeUploadThumb(truncated, 'image/jpeg')).resolves.toEqual({ ok: false, reason: 'corrupt' });
  });

  it('не картинка при image/png — отказ, без исключения', async () => {
    const result = await makeUploadThumb(Buffer.from('не картинка'), 'image/png');
    expect(result.ok).toBe(false);
  });

  it('пустой буфер — corrupt', async () => {
    await expect(makeUploadThumb(Buffer.alloc(0), 'image/png')).resolves.toEqual({ ok: false, reason: 'corrupt' });
  });

  it('нет места за отведённое ожидание — busy; место освободилось — миниатюра есть', async () => {
    const slots = new UploadThumbSlots(1);
    const release = await slots.acquire(0);
    expect(release).not.toBeNull();
    const png = await image(1000, 600).png().toBuffer();

    await expect(makeUploadThumb(png, 'image/png', { slots, waitMs: 20 })).resolves.toEqual({
      ok: false,
      reason: 'busy',
    });

    release!();
    expect((await makeUploadThumb(png, 'image/png', { slots, waitMs: 20 })).ok).toBe(true);
  });
});

describe('UploadThumbSlots', () => {
  it('не больше limit одновременно; освобождённое место достаётся ждущему', async () => {
    const slots = new UploadThumbSlots(2);
    const first = await slots.acquire(0);
    const second = await slots.acquire(0);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const third = slots.acquire(1000);
    first!();
    const granted = await third;
    expect(granted).not.toBeNull();

    // Оба места снова заняты (second и granted): четвёртый не дождётся.
    await expect(slots.acquire(20)).resolves.toBeNull();
    second!();
    granted!();
  });

  it('повторный вызов освобождающей функции не отдаёт лишнее место', async () => {
    const slots = new UploadThumbSlots(1);
    const release = await slots.acquire(0);
    release!();
    release!();
    const a = await slots.acquire(0);
    expect(a).not.toBeNull();
    await expect(slots.acquire(20)).resolves.toBeNull();
    a!();
  });

  it('ждущий, не дождавшийся места, не съедает его позже', async () => {
    const slots = new UploadThumbSlots(1);
    const hold = await slots.acquire(0);
    await expect(slots.acquire(10)).resolves.toBeNull();
    hold!();
    const next = await slots.acquire(0);
    expect(next).not.toBeNull();
    next!();
  });
});

describe('classifyThumbError', () => {
  it.each([
    ['Input image exceeds pixel limit', 'pixel_limit'],
    ['timeout: 42% complete', 'timeout'],
    ['Input buffer contains unsupported image format', 'unsupported'],
    ['heif: Unsupported feature: Unsupported codec (4.3000)', 'unsupported'],
    ['VipsJpeg: premature end of JPEG image', 'corrupt'],
    ['pngload_buffer: libpng read error', 'corrupt'],
  ])('"%s" → %s', (message, reason) => {
    expect(classifyThumbError(new Error(message))).toBe(reason);
  });

  it('не Error — corrupt', () => {
    expect(classifyThumbError('что-то')).toBe('corrupt');
    expect(classifyThumbError(undefined)).toBe('corrupt');
  });
});
