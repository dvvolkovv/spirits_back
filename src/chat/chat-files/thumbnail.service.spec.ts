import sharp = require('sharp');
import { ThumbnailService } from './thumbnail.service';
import { THUMB_BUCKET, thumbKeyFor } from './thumbnails';

const SRC = { bucket: 'linkeon-chat-files', key: 'u/a.png' };
let PNG: Buffer;
beforeAll(async () => {
  PNG = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3366ff' } }).png().toBuffer();
});

function fakeStorage(
  opts: {
    thumbExists?: boolean;
    sourceSize?: number;
    sourceMissing?: boolean;
    downloadDelayMs?: number;
    /** Ключи, у которых download никогда не разрешается — имитация зависшего MinIO. */
    hangKeys?: Set<string>;
  } = {},
) {
  const uploads: any[] = [];
  let downloading = 0;
  let maxDownloading = 0;
  const storage = {
    publicUrl: (b: string, k: string) => `https://pub/${b}/${k}`,
    head: jest.fn(async (b: string, k: string) => {
      if (b === THUMB_BUCKET && k.startsWith('thumbs/')) return opts.thumbExists ? { size: 10 } : null;
      return opts.sourceMissing ? null : { size: opts.sourceSize ?? PNG.length };
    }),
    download: jest.fn(async (input: { key: string }) => {
      if (opts.hangKeys?.has(input.key)) return new Promise<Buffer>(() => {});
      downloading++;
      maxDownloading = Math.max(maxDownloading, downloading);
      if (opts.downloadDelayMs) await new Promise((r) => setTimeout(r, opts.downloadDelayMs));
      downloading--;
      return PNG;
    }),
    upload: jest.fn(async (u: any) => {
      uploads.push(u);
      return `https://pub/${u.bucket}/${u.key}`;
    }),
  };
  return { storage, uploads, maxDownloading: () => maxDownloading };
}

const thumbUrl = (s = SRC) => `https://pub/${THUMB_BUCKET}/${thumbKeyFor(s)}`;

describe('ThumbnailService.resolve', () => {
  it('миниатюра уже есть — адрес без скачивания исходника', async () => {
    const { storage } = fakeStorage({ thumbExists: true });
    expect(await new ThumbnailService(storage as any).resolve(SRC)).toBe(thumbUrl());
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('миниатюры нет — делает WebP и кладёт в бакет', async () => {
    const { storage, uploads } = fakeStorage();
    expect(await new ThumbnailService(storage as any).resolve(SRC)).toBe(thumbUrl());
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ bucket: THUMB_BUCKET, key: thumbKeyFor(SRC), contentType: 'image/webp' });
    expect((await sharp(uploads[0].body).metadata()).format).toBe('webp');
  });

  it('второй запрос — из памяти, без похода в MinIO', async () => {
    const { storage } = fakeStorage();
    const svc = new ThumbnailService(storage as any);
    await svc.resolve(SRC);
    storage.head.mockClear();
    await svc.resolve(SRC);
    expect(storage.head).not.toHaveBeenCalled();
  });

  it('исходник больше 25 МБ — отказ без скачивания', async () => {
    const { storage } = fakeStorage({ sourceSize: 26 * 1024 * 1024 });
    await expect(new ThumbnailService(storage as any).resolve(SRC)).rejects.toThrow(/больше/);
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('исходника нет — отказ', async () => {
    const { storage } = fakeStorage({ sourceMissing: true });
    await expect(new ThumbnailService(storage as any).resolve(SRC)).rejects.toThrow('исходника нет');
  });

  it('одинаковые запросы в полёте — одна работа', async () => {
    const { storage } = fakeStorage({ downloadDelayMs: 30 });
    const svc = new ThumbnailService(storage as any);
    await Promise.all([svc.resolve(SRC), svc.resolve(SRC), svc.resolve(SRC)]);
    expect(storage.download).toHaveBeenCalledTimes(1);
  });

  it('не больше двух уменьшений разом', async () => {
    const f = fakeStorage({ downloadDelayMs: 30 });
    const svc = new ThumbnailService(f.storage as any);
    await Promise.all([1, 2, 3, 4, 5].map((i) => svc.resolve({ bucket: 'linkeon-chat-files', key: `u/${i}.png` })));
    expect(f.storage.download).toHaveBeenCalledTimes(5);
    expect(f.maxDownloading()).toBe(2);
  });

  it('очередь дольше срока — отказ, а не вечное ожидание', async () => {
    const f = fakeStorage({ downloadDelayMs: 200 });
    const svc = new ThumbnailService(f.storage as any);
    const runs = [1, 2, 3].map((i) => svc.resolve({ bucket: 'linkeon-chat-files', key: `u/${i}.png` }, 50));
    const results = await Promise.allSettled(runs);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it(
    'работа зависла после слота — отказ по сроку, слот освобождается для других',
    async () => {
      const hangKeys = new Set(['u/hang1.png', 'u/hang2.png']);
      const { storage } = fakeStorage({ hangKeys });
      const svc = new ThumbnailService(storage as any);

      // Два зависших download'а занимают оба места (THUMB_CONCURRENCY = 2).
      const hangs = ['u/hang1.png', 'u/hang2.png'].map((key) =>
        svc.resolve({ bucket: 'linkeon-chat-files', key }, 1000, 50),
      );
      const hangResults = await Promise.allSettled(hangs);
      expect(hangResults.every((r) => r.status === 'rejected')).toBe(true);
      for (const r of hangResults) {
        expect((r as PromiseRejectedResult).reason.message).toMatch(/не уложилась/);
      }

      // Места освободились — обычный запрос проходит, а не ждёт зависших навечно.
      const normalSrc = { bucket: 'linkeon-chat-files', key: 'u/normal.png' };
      expect(await svc.resolve(normalSrc, 1000, 50)).toBe(thumbUrl(normalSrc));
    },
    2000,
  );
});
