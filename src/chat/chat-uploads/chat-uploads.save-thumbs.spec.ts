import sharp = require('sharp');
import { ChatUploadsService } from './chat-uploads.service';
import * as uploadThumb from './upload-thumb';
import {
  UPLOAD_THUMB_CALL_BUDGET_MS,
  UPLOAD_THUMB_QUEUE_WAIT_MS,
  UploadThumbSlots,
  uploadThumbKey,
} from './upload-thumb';

/**
 * saveOriginals после миграции 002: source в INSERT и webp-миниатюра картинки
 * в том же приватном бакете. Моки pg/storage — в стиле chat-uploads.service.spec.ts;
 * картинки — синтетические, сделаны sharp прямо в тесте.
 */
describe('ChatUploadsService.saveOriginals: источник и миниатюры (002)', () => {
  // INSERT отвечает строкой, собранной из своих же параметров: так результат
  // saveOriginals показывает, что именно записано в source и thumb_key.
  const insertEcho = async (_sql: string, params: unknown[] = []) => ({
    rows: [{
      id: '55555555-5555-4555-8555-555555555555',
      user_id: params[0],
      session_id: params[1],
      original_name: params[2],
      mime: params[3],
      size_bytes: params[4],
      sha256: params[5],
      storage_key: params[6],
      source: params[7],
      thumb_key: params[8],
      note: null,
      note_updated_at: null,
      note_assistant_id: null,
      created_at: new Date('2026-11-16T09:00:00.000Z'),
    }],
  });
  const pg = { query: jest.fn(insertEcho) };
  const storage = {
    upload: jest.fn(async (_input: any) => 'https://public.invalid/should-not-be-used'),
    delete: jest.fn(async (_input: any) => {}),
    createBucketIfAbsent: jest.fn(async () => {}),
  };
  const service = new ChatUploadsService(pg as any, storage as any);
  const warn = jest.spyOn((service as any).logger, 'warn');

  let jpeg: Buffer;
  beforeAll(async () => {
    jpeg = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#ff6600' } })
      .jpeg()
      .toBuffer();
  });

  // mockReset, а не clearAllMocks: недоеденные *Once одного теста не
  // переезжают в следующий; поведение по умолчанию ставится заново.
  beforeEach(() => {
    pg.query.mockReset().mockImplementation(insertEcho);
    storage.upload.mockReset().mockImplementation(async () => 'https://public.invalid/should-not-be-used');
    storage.delete.mockReset().mockImplementation(async () => {});
    storage.createBucketIfAbsent.mockReset().mockImplementation(async () => {});
    warn.mockReset().mockImplementation(() => undefined);
  });

  const insertParams = () => pg.query.mock.calls[0][1] as unknown[];
  const warnLines = () => warn.mock.calls.map((call) => String(call[0]));
  /** Ключи оригиналов в порядке загрузки (без миниатюр thumbs/…). */
  const originalKeys = () =>
    storage.upload.mock.calls.map((call) => String(call[0].key)).filter((key) => !key.startsWith('thumbs/'));
  /**
   * Обезличенный id объекта в журнале: случайный uuid — первый сегмент
   * ключа хранилища (`<uuid>/<имя>`), в кавычках, как logId.
   */
  const keyId = (storageKey: string) => JSON.stringify(storageKey.split('/')[0]);
  const skippedLine = (storageKey: string, mime: string, reason: string) =>
    `saveOriginals: thumbnail skipped (key=${keyId(storageKey)}, mime=${JSON.stringify(mime)}): ${reason}`;

  it('картинка: оригинал и WebP-миниатюра в тот же бакет, thumb_key и source=web в INSERT', async () => {
    const result = await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_12',
      files: [{ buffer: jpeg, originalname: 'гостиная.jpg', mimetype: 'image/jpeg' }],
    });

    expect(storage.upload).toHaveBeenCalledTimes(2);
    const original = storage.upload.mock.calls[0][0];
    const thumb = storage.upload.mock.calls[1][0];
    expect(original).toMatchObject({ bucket: 'linkeon-chat-uploads', contentType: 'image/jpeg' });
    expect(thumb).toMatchObject({
      bucket: 'linkeon-chat-uploads',
      key: uploadThumbKey(original.key),
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
    });
    const meta = await sharp(thumb.body as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(480);

    const sql = String(pg.query.mock.calls[0][0]);
    expect(sql).toMatch(
      /\(user_id, session_id, original_name, mime, size_bytes, sha256, storage_key, source, thumb_key\)/,
    );
    expect(insertParams().slice(7)).toEqual(['web', uploadThumbKey(original.key)]);
    expect(result.failed).toEqual([]);
    expect(result.saved[0]).toMatchObject({ source: 'web', thumbKey: uploadThumbKey(original.key) });
  });

  it('source=scan доходит до INSERT; PDF — без миниатюры', async () => {
    const result = await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_3',
      source: 'scan',
      files: [{ buffer: Buffer.from('%PDF-1.4 synthetic'), originalname: 'скан.pdf', mimetype: 'application/pdf' }],
    });

    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(insertParams().slice(7)).toEqual(['scan', null]);
    expect(result.saved[0]).toMatchObject({ source: 'scan', thumbKey: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([['image/svg+xml'], ['image/bmp'], ['image/x-icon'], ['image/heic']])(
    '%s — без миниатюры и молча (решение по белому списку, не по байтам)',
    async (mimetype) => {
      // Байты — настоящий JPEG: значит, отказ именно по mime.
      const result = await service.saveOriginals({
        userId: 'u1',
        sessionId: 'u1_12',
        files: [{ buffer: jpeg, originalname: 'картинка', mimetype }],
      });

      expect(storage.upload).toHaveBeenCalledTimes(1);
      expect(insertParams().slice(7)).toEqual(['web', null]);
      expect(result.saved[0]).toMatchObject({ thumbKey: null });
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('битая картинка: файл сохраняется, thumb_key NULL, в логе id объекта, mime и причина — без имени и байтов', async () => {
    const jpegHalf = jpeg.subarray(0, Math.floor(jpeg.length / 2));
    const result = await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_12',
      files: [
        { buffer: Buffer.from('СЕКРЕТНОЕ-СОДЕРЖИМОЕ'), originalname: 'фото.png', mimetype: 'image/png' },
        { buffer: jpegHalf, originalname: 'обрезок.jpg', mimetype: 'image/jpeg' },
      ],
    });

    expect(storage.upload).toHaveBeenCalledTimes(2); // только оригиналы
    expect(pg.query.mock.calls.map((call) => (call[1] as unknown[]).slice(7))).toEqual([
      ['web', null],
      ['web', null],
    ]);
    expect(result.failed).toEqual([]);
    expect(result.saved.map((r) => r.thumbKey)).toEqual([null, null]);
    const [pngKey, jpgKey] = originalKeys();
    expect(warnLines()).toEqual([
      skippedLine(pngKey, 'image/png', 'unsupported'),
      skippedLine(jpgKey, 'image/jpeg', 'corrupt'),
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const leak of ['СЕКРЕТНОЕ', 'фото', 'обрезок', 'u1_12']) {
      expect(logged).not.toContain(leak);
    }
  });

  it('строка пропуска миниатюры: ни имени файла, ни параметров mime — только тип из белого списка', async () => {
    // Параметры после «;» isThumbnailableMime пропускает, а в них клиент
    // может прислать что угодно, в том числе имя с переводом строки.
    await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_12',
      files: [{
        buffer: Buffer.from('не картинка'),
        originalname: 'фото"\nFAKE: подделка.png',
        mimetype: 'IMAGE/PNG; name="паспорт\nFAKE.png"',
      }],
    });

    expect(warnLines()).toEqual([skippedLine(originalKeys()[0], 'image/png', 'unsupported')]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const leak of ['фото', 'FAKE', 'подделка', 'паспорт', 'name=', 'u1_12']) {
      expect(logged).not.toContain(leak);
    }
  });

  it('сбой загрузки миниатюры в MinIO: файл сохраняется без thumb_key, удаляется только ключ миниатюры', async () => {
    storage.upload
      .mockResolvedValueOnce('https://public.invalid/original')
      .mockRejectedValueOnce(new Error('minio down'));

    const result = await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_12',
      files: [{ buffer: jpeg, originalname: 'гостиная.jpg', mimetype: 'image/jpeg' }],
    });

    expect(result.failed).toEqual([]);
    expect(result.saved).toHaveLength(1);
    expect(insertParams().slice(7)).toEqual(['web', null]);
    // PutObject мог лечь, а ответ потеряться: ключ миниатюры чистится
    // (DeleteObject идемпотентен), оригинал остаётся.
    const originalKey = storage.upload.mock.calls[0][0].key;
    expect(storage.delete.mock.calls.map((call) => call[0])).toEqual([
      { bucket: 'linkeon-chat-uploads', key: uploadThumbKey(originalKey) },
    ]);
  });

  it('сбой загрузки миниатюры и её уборки: файл всё равно сохраняется, в журнале только id объекта и вид ошибки', async () => {
    // Сообщения S3 повторяют ключ объекта, а в нём имя файла.
    storage.upload
      .mockResolvedValueOnce('https://public.invalid/original')
      .mockRejectedValueOnce(new Error('PutObject thumbs/гостиная.jpg.webp: minio down'));
    storage.delete.mockRejectedValueOnce(
      Object.assign(new Error('DeleteObject гостиная.jpg.webp: minio still down'), { code: 'ECONNRESET' }),
    );

    const result = await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_12',
      files: [{ buffer: jpeg, originalname: 'гостиная.jpg', mimetype: 'image/jpeg' }],
    });

    expect(result.failed).toEqual([]);
    expect(result.saved[0]).toMatchObject({ thumbKey: null });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    const [key] = originalKeys();
    expect(warnLines()).toEqual([
      `saveOriginals: thumbnail upload failed (key=${keyId(key)}): Error`,
      `saveOriginals: thumbnail cleanup delete failed (key=${keyId(key)}): Error code=ECONNRESET`,
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const leak of ['гостиная', 'PutObject', 'DeleteObject', 'minio', 'u1_12']) {
      expect(logged).not.toContain(leak);
    }
  });

  it('сбой INSERT после миниатюры: удаляются и оригинал, и миниатюра', async () => {
    pg.query.mockRejectedValueOnce(new Error('db down'));

    const result = await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_12',
      files: [{ buffer: jpeg, originalname: 'гостиная.jpg', mimetype: 'image/jpeg' }],
    });

    expect(result.failed).toEqual(['гостиная.jpg']);
    const originalKey = storage.upload.mock.calls[0][0].key;
    expect(storage.delete.mock.calls.map((call) => call[0])).toEqual([
      { bucket: 'linkeon-chat-uploads', key: originalKey },
      { bucket: 'linkeon-chat-uploads', key: uploadThumbKey(originalKey) },
    ]);
  });

  it('сбой записи и уборки: в журнале только вид ошибки — без имени файла, текста ошибки и сессии', async () => {
    const name = 'отчёт"\nFAKE: подделка.pdf';
    // Сообщения pg и S3 повторяют имя файла и ключ объекта — их в журнал нельзя.
    const insertError = Object.assign(new Error('insert failed: отчёт подделка.pdf in u1_12'), { code: '23505' });
    const cleanupError = Object.assign(new Error('DeleteObject denied for подделка.pdf'), { name: 'AccessDenied' });
    pg.query.mockRejectedValueOnce(insertError);
    storage.delete.mockRejectedValueOnce(cleanupError);

    const result = await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_12',
      files: [{ buffer: Buffer.from('%PDF-1.4 synthetic'), originalname: name, mimetype: 'application/pdf' }],
    });

    expect(result.failed).toEqual([name]);
    // Строки и их префиксы стабильны — по ним грепают журнал.
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      'saveOriginals: failed to persist file: Error code=23505',
      'saveOriginals: best-effort cleanup delete failed: AccessDenied',
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const leak of ['отчёт', 'подделка', 'FAKE', 'insert failed', 'DeleteObject', 'u1_12']) {
      expect(logged).not.toContain(leak);
    }
  });

  describe('общий бюджет миниатюр на один вызов', () => {
    const shots = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        buffer: jpeg,
        originalname: `фото-${i + 1}.jpg`,
        mimetype: 'image/jpeg',
      }));
    const thumbKeysInInsert = () => pg.query.mock.calls.map((call) => (call[1] as unknown[])[8]);

    let nowSpy: jest.SpyInstance | undefined;
    afterEach(() => {
      nowSpy?.mockRestore();
      nowSpy = undefined;
      delete (service as any).thumbSlots;
    });

    it('после первого busy миниатюры остальных файлов пропускаются, оригиналы сохраняются все', async () => {
      // Подменённые места: свободного не бывает.
      const acquire = jest.fn(async (_waitMs: number) => null);
      (service as any).thumbSlots = { acquire };

      const result = await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: shots(3) });

      expect(acquire).toHaveBeenCalledTimes(1);
      expect(acquire.mock.calls[0][0]).toBeGreaterThan(0);
      expect(acquire.mock.calls[0][0]).toBeLessThanOrEqual(UPLOAD_THUMB_QUEUE_WAIT_MS);
      expect(result.failed).toEqual([]);
      expect(result.saved).toHaveLength(3);
      expect(originalKeys()).toHaveLength(3);
      expect(storage.upload).toHaveBeenCalledTimes(3); // ни одной миниатюры
      expect(thumbKeysInInsert()).toEqual([null, null, null]);
      const keys = originalKeys();
      expect(warnLines()).toEqual([
        skippedLine(keys[0], 'image/jpeg', 'busy'),
        skippedLine(keys[1], 'image/jpeg', 'budget'),
        skippedLine(keys[2], 'image/jpeg', 'budget'),
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('фото');
    });

    it('после timeout — так же: остальные файлы вызова без миниатюр', async () => {
      const make = jest
        .spyOn(uploadThumb, 'makeUploadThumb')
        .mockResolvedValueOnce({ ok: false, reason: 'timeout' });
      try {
        const result = await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: shots(2) });

        expect(make).toHaveBeenCalledTimes(1);
        expect(result.saved).toHaveLength(2);
        expect(thumbKeysInInsert()).toEqual([null, null]);
        const keys = originalKeys();
        expect(warnLines()).toEqual([
          skippedLine(keys[0], 'image/jpeg', 'timeout'),
          skippedLine(keys[1], 'image/jpeg', 'budget'),
        ]);
      } finally {
        make.mockRestore();
      }
    });

    it('ожидание места — не больше остатка бюджета; бюджет кончился — миниатюр больше нет', async () => {
      let now = 1_000_000;
      nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const real = new UploadThumbSlots(2);
      const acquire = jest.fn((waitMs: number) => real.acquire(waitMs));
      (service as any).thumbSlots = { acquire };
      // Каждая легшая миниатюра «съедает» 7 с бюджета вызова.
      storage.upload.mockImplementation(async (input: any) => {
        if (String(input.key).startsWith('thumbs/')) now += 7_000;
        return 'https://public.invalid/should-not-be-used';
      });

      const result = await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: shots(3) });

      expect(acquire.mock.calls.map((call) => call[0])).toEqual([
        Math.min(UPLOAD_THUMB_QUEUE_WAIT_MS, UPLOAD_THUMB_CALL_BUDGET_MS),
        Math.min(UPLOAD_THUMB_QUEUE_WAIT_MS, UPLOAD_THUMB_CALL_BUDGET_MS - 7_000),
      ]);
      expect(result.failed).toEqual([]);
      expect(result.saved).toHaveLength(3);
      const keys = originalKeys();
      expect(keys).toHaveLength(3);
      expect(thumbKeysInInsert()).toEqual([uploadThumbKey(keys[0]), uploadThumbKey(keys[1]), null]);
      expect(warnLines()).toEqual([skippedLine(keys[2], 'image/jpeg', 'budget')]);
    });

    it('бюджет — новый на каждый вызов', async () => {
      const acquire = jest.fn(async (_waitMs: number) => null);
      (service as any).thumbSlots = { acquire };
      await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: shots(2) });
      delete (service as any).thumbSlots;

      const result = await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: shots(1) });
      expect(result.saved[0].thumbKey).toBe(uploadThumbKey(originalKeys()[2]));
    });
  });
});
