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
  const pg = {
    query: jest.fn(async (_sql: string, params: unknown[] = []) => ({
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
    })),
  };
  const storage = {
    upload: jest.fn(async (_input: any) => 'https://public.invalid/should-not-be-used'),
    delete: jest.fn(async (_input: any) => {}),
    createBucketIfAbsent: jest.fn(async () => {}),
  };
  const service = new ChatUploadsService(pg as any, storage as any);
  const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

  let jpeg: Buffer;
  beforeAll(async () => {
    jpeg = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#ff6600' } })
      .jpeg()
      .toBuffer();
  });

  beforeEach(() => jest.clearAllMocks());

  const insertParams = () => pg.query.mock.calls[0][1] as unknown[];

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
  });

  it('битая картинка: файл сохраняется, thumb_key NULL, в логе нет байтов', async () => {
    const result = await service.saveOriginals({
      userId: 'u1',
      sessionId: 'u1_12',
      files: [{ buffer: Buffer.from('СЕКРЕТНОЕ-СОДЕРЖИМОЕ'), originalname: 'фото.png', mimetype: 'image/png' }],
    });

    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(insertParams().slice(7)).toEqual(['web', null]);
    expect(result.failed).toEqual([]);
    expect(result.saved[0]).toMatchObject({ thumbKey: null });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('СЕКРЕТНОЕ');
  });

  it('сбой загрузки миниатюры в MinIO: файл сохраняется без thumb_key, оригинал не удаляется', async () => {
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
    expect(storage.delete).not.toHaveBeenCalled();
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
