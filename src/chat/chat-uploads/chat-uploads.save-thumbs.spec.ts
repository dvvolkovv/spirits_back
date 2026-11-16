import sharp = require('sharp');
import { ChatUploadsService } from './chat-uploads.service';
import { uploadThumbKey } from './upload-thumb';

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
  const warnText = () => warn.mock.calls.map((call) => String(call[0])).join('\n');

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

  it('битая картинка: файл сохраняется, thumb_key NULL, в логе имя, mime и причина — без байтов', async () => {
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
    expect(warnText()).toContain('"фото.png" ("image/png"): unsupported');
    expect(warnText()).toContain('"обрезок.jpg" ("image/jpeg"): corrupt');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('СЕКРЕТНОЕ');
  });

  it('имя файла в логе миниатюры экранировано: перевод строки не рвёт запись', async () => {
    await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_12',
      files: [{ buffer: Buffer.from('не картинка'), originalname: 'фото"\nFAKE: подделка.png', mimetype: 'image/png' }],
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain('\n');
    expect(line).toContain(JSON.stringify('фото"\nFAKE: подделка.png'));
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

  it('сбой загрузки миниатюры и её уборки: файл всё равно сохраняется', async () => {
    storage.upload
      .mockResolvedValueOnce('https://public.invalid/original')
      .mockRejectedValueOnce(new Error('minio down'));
    storage.delete.mockRejectedValueOnce(new Error('minio still down'));

    const result = await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_12',
      files: [{ buffer: jpeg, originalname: 'гостиная.jpg', mimetype: 'image/jpeg' }],
    });

    expect(result.failed).toEqual([]);
    expect(result.saved[0]).toMatchObject({ thumbKey: null });
    expect(storage.delete).toHaveBeenCalledTimes(1);
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
});
