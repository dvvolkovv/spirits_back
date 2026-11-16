import sharp = require('sharp');
import { UPLOAD_THUMB_MAX_SIDE, makeUploadThumb, uploadThumbKey } from './upload-thumb';

/** Синтетическая однотонная картинка — без единого байта реальных данных. */
const image = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#3366ff' } });

describe('uploadThumbKey', () => {
  it('thumbs/<storage_key>.webp — ключ оригинала с префиксом и суффиксом', () => {
    expect(uploadThumbKey('6eb9089f-0000-4000-8000-000000000000/кот (1).png')).toBe(
      'thumbs/6eb9089f-0000-4000-8000-000000000000/кот (1).png.webp',
    );
  });
});

describe('makeUploadThumb', () => {
  it('длинная сторона миниатюры — 480 px', () => {
    expect(UPLOAD_THUMB_MAX_SIDE).toBe(480);
  });

  it('PNG 1000×600 → WebP 480×288 (пропорции сохранены)', async () => {
    const thumb = await makeUploadThumb(await image(1000, 600).png().toBuffer(), 'image/png');
    expect(thumb).not.toBeNull();
    const meta = await sharp(thumb as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([480, 288]);
  });

  it('JPEG 600×1000 (портрет) → WebP 288×480', async () => {
    const thumb = await makeUploadThumb(await image(600, 1000).jpeg().toBuffer(), 'image/jpeg');
    const meta = await sharp(thumb as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([288, 480]);
  });

  it('маленькая картинка не растягивается', async () => {
    const thumb = await makeUploadThumb(await image(200, 100).png().toBuffer(), 'image/png');
    const meta = await sharp(thumb as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([200, 100]);
  });

  it('mime в верхнем регистре — тоже картинка', async () => {
    const thumb = await makeUploadThumb(await image(1000, 600).jpeg().toBuffer(), 'IMAGE/JPEG');
    expect(thumb).not.toBeNull();
  });

  it.each([['application/pdf'], ['video/mp4'], ['image/svg+xml'], ['']])(
    'mime "%s" — null, даже если байты — картинка',
    async (mime) => {
      const png = await image(1000, 600).png().toBuffer();
      await expect(makeUploadThumb(png, mime)).resolves.toBeNull();
    },
  );

  it('битые байты при image/png — null, без исключения', async () => {
    await expect(makeUploadThumb(Buffer.from('не картинка'), 'image/png')).resolves.toBeNull();
  });

  it('пустой буфер — null', async () => {
    await expect(makeUploadThumb(Buffer.alloc(0), 'image/png')).resolves.toBeNull();
  });
});
