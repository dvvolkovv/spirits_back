import { NotFoundException } from '@nestjs/common';
import { ChatUploadsService } from './chat-uploads.service';
import * as uploadThumb from './upload-thumb';
import { uploadThumbKey } from './upload-thumb';

/**
 * Запись в реестр загрузок — только живому аккаунту (гейт после удаления).
 *
 * Access-токен живёт до двух часов после DELETE /webhook/profile, и всё это
 * время upload-and-chat, scan-document и note_file принимают запросы. Строка
 * chat_uploads, записанная в это окно, переживает удаление: chat-upload.purge
 * приходит через 30 дней, а если в момент удаления загрузок не было, задачи
 * purge нет вовсе. Поэтому INSERT и UPDATE идут под тем же EXISTS, что и
 * строки истории (chat.service.ts, saveUserMessageRow): user_id.state = 'active'.
 *
 * Моки pg/storage — в стиле chat-uploads.save-thumbs.spec.ts. userId похож на
 * телефон (так устроен internal_id телефонного входа) — его, имени файла и
 * ключа сессии в журнале быть не должно.
 */

const OWNER = '70000000123';
const SESSION = `${OWNER}_12`;
const ACTIVE_OWNER_SQL =
  /EXISTS \(SELECT 1 FROM user_id u WHERE u\.internal_id = \$(\d+) AND u\.state = 'active'\)/;

describe('ChatUploadsService.saveOriginals: только живой владелец', () => {
  // INSERT живому владельцу отвечает строкой из своих же параметров.
  const insertEcho = async (_sql: string, params: unknown[] = []) => ({
    rows: [{
      id: '66666666-6666-4666-8666-666666666666',
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
      created_at: new Date('2026-11-18T09:00:00.000Z'),
    }],
  });
  // Владелец не активен: EXISTS ложен, INSERT … SELECT не вставил ничего.
  const noRows = async (_sql: string, _params: unknown[] = []) => ({ rows: [] as any[], rowCount: 0 });

  const pg = { query: jest.fn(insertEcho) };
  const storage = {
    upload: jest.fn(async (_input: any) => 'https://public.invalid/should-not-be-used'),
    delete: jest.fn(async (_input: any) => {}),
    createBucketIfAbsent: jest.fn(async () => {}),
  };
  const service = new ChatUploadsService(pg as any, storage as any);
  const warn = jest.spyOn((service as any).logger, 'warn');
  let thumb: jest.SpyInstance;

  beforeEach(() => {
    pg.query.mockReset().mockImplementation(insertEcho);
    storage.upload.mockReset().mockImplementation(async () => 'https://public.invalid/should-not-be-used');
    storage.delete.mockReset().mockImplementation(async () => {});
    storage.createBucketIfAbsent.mockReset().mockImplementation(async () => {});
    warn.mockReset().mockImplementation(() => undefined);
    // Миниатюра без sharp: проверяется уборка её ключа, а не рендер.
    thumb = jest
      .spyOn(uploadThumb, 'makeUploadThumb')
      .mockResolvedValue({ ok: true, webp: Buffer.from('synthetic-webp') });
  });

  afterEach(() => thumb.mockRestore());

  const originalKeys = () =>
    storage.upload.mock.calls.map((call) => String(call[0].key)).filter((key) => !key.startsWith('thumbs/'));
  const keyId = (storageKey: string) => JSON.stringify(storageKey.split('/')[0]);
  const warnLines = () => warn.mock.calls.map((call) => String(call[0]));
  const photo = (name: string) => ({ buffer: Buffer.from('jpeg-bytes'), originalname: name, mimetype: 'image/jpeg' });

  it('INSERT … SELECT … WHERE EXISTS(живой владелец) … RETURNING; владелец — тот же $1, параметры на прежних местах', async () => {
    const result = await service.saveOriginals({ userId: OWNER, sessionId: SESSION, files: [photo('гостиная.jpg')] });

    expect(pg.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pg.query.mock.calls[0];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toMatch(
      /^INSERT INTO chat_uploads \(user_id, session_id, original_name, mime, size_bytes, sha256, storage_key, source, thumb_key\) SELECT \$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9 WHERE EXISTS/,
    );
    expect(text).not.toMatch(/\bVALUES\b/);
    expect(text).toMatch(/ RETURNING /);
    const match = text.match(ACTIVE_OWNER_SQL);
    expect(match).not.toBeNull();
    // Номер параметра в EXISTS — именно userId.
    expect(params![Number(match![1]) - 1]).toBe(OWNER);
    expect(params).toHaveLength(9);
    expect(params![0]).toBe(OWNER);
    expect((params as unknown[]).slice(7)).toEqual(['web', uploadThumbKey(originalKeys()[0])]);
    expect(result.failed).toEqual([]);
    expect(result.saved).toHaveLength(1);
  });

  it('владелец не активен: оригинал и миниатюра удаляются, файл — в failed, без исключения', async () => {
    pg.query.mockImplementation(noRows);

    const result = await service.saveOriginals({ userId: OWNER, sessionId: SESSION, files: [photo('паспорт.jpg')] });

    expect(result).toEqual({ saved: [], failed: ['паспорт.jpg'] });
    const [originalKey] = originalKeys();
    expect(storage.upload.mock.calls.map((call) => call[0].key)).toEqual([originalKey, uploadThumbKey(originalKey)]);
    expect(storage.delete.mock.calls.map((call) => call[0])).toEqual([
      { bucket: 'linkeon-chat-uploads', key: originalKey },
      { bucket: 'linkeon-chat-uploads', key: uploadThumbKey(originalKey) },
    ]);
  });

  it('владелец не активен: одна строка журнала с обезличенным id объекта — без телефона, имени файла и сессии', async () => {
    pg.query.mockImplementation(noRows);

    await service.saveOriginals({
      userId: OWNER,
      sessionId: SESSION,
      files: [{ buffer: Buffer.from('%PDF-1.4 synthetic'), originalname: 'договор"\nFAKE.pdf', mimetype: 'application/pdf' }],
    });

    const [key] = originalKeys();
    expect(warnLines()).toEqual([`saveOriginals: owner not active (key=${keyId(key)})`]);
    expect(keyId(key)).toMatch(/^"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"$/);
    // Это не сбой сохранения: строки failed to persist быть не должно.
    expect(warnLines().join('\n')).not.toContain('failed to persist');
    const logged = JSON.stringify(warn.mock.calls);
    for (const leak of [OWNER, SESSION, 'договор', 'FAKE']) {
      expect(logged).not.toContain(leak);
    }
  });

  it('владелец не активен и уборка не удалась: файл всё равно в failed, в журнале только вид ошибки', async () => {
    pg.query.mockImplementation(noRows);
    storage.delete.mockRejectedValueOnce(
      Object.assign(new Error(`DeleteObject паспорт.jpg for ${OWNER}`), { code: 'ECONNRESET' }),
    );

    const result = await service.saveOriginals({ userId: OWNER, sessionId: SESSION, files: [photo('паспорт.jpg')] });

    expect(result).toEqual({ saved: [], failed: ['паспорт.jpg'] });
    // Сбой уборки оригинала не мешает убрать миниатюру.
    expect(storage.delete).toHaveBeenCalledTimes(2);
    const [key] = originalKeys();
    expect(warnLines()).toEqual([
      `saveOriginals: owner not active (key=${keyId(key)})`,
      `saveOriginals: best-effort cleanup delete failed (key=${keyId(key)}): Error code=ECONNRESET`,
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const leak of [OWNER, SESSION, 'паспорт', 'DeleteObject']) {
      expect(logged).not.toContain(leak);
    }
  });

  it('владелец не активен: остальные файлы вызова в хранилище не пишутся и тоже уходят в failed', async () => {
    pg.query.mockImplementation(noRows);

    const result = await service.saveOriginals({
      userId: OWNER,
      sessionId: SESSION,
      files: [photo('1.jpg'), photo('2.jpg'), photo('3.jpg')],
    });

    expect(result).toEqual({ saved: [], failed: ['1.jpg', '2.jpg', '3.jpg'] });
    // Только первый файл дошёл до хранилища (оригинал + миниатюра) и убран.
    expect(storage.upload).toHaveBeenCalledTimes(2);
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(warnLines()).toEqual([`saveOriginals: owner not active (key=${keyId(originalKeys()[0])})`]);
  });

  it('сбой INSERT по-прежнему — failed to persist, а не owner not active', async () => {
    pg.query.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: '57P01' }));

    const result = await service.saveOriginals({ userId: OWNER, sessionId: SESSION, files: [photo('a.jpg')] });

    expect(result.failed).toEqual(['a.jpg']);
    const [key] = originalKeys();
    expect(warnLines()).toEqual([`saveOriginals: failed to persist file (key=${keyId(key)}): Error code=57P01`]);
  });
});

describe('ChatUploadsService.setNote: только живой владелец', () => {
  const ID = '77777777-7777-4777-8777-777777777777';
  const pg = { query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as any[], rowCount: 0 })) };
  const service = new ChatUploadsService(pg as any, {} as any);
  const logger = (service as any).logger;
  const spies = ['log', 'warn', 'error', 'debug', 'verbose'].map((level) =>
    jest.spyOn(logger, level).mockImplementation(() => undefined),
  );

  beforeEach(() => {
    pg.query.mockReset().mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    for (const spy of spies) spy.mockClear();
  });

  it('UPDATE — под EXISTS(живой владелец) по тому же $2, что user_id', async () => {
    await service.setNote({ id: ID, userId: OWNER, note: 'Скан договора', assistantId: '3' }).catch(() => undefined);

    expect(pg.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pg.query.mock.calls[0];
    const text = String(sql).replace(/\s+/g, ' ');
    expect(text).toMatch(/^UPDATE chat_uploads SET /);
    expect(text).toMatch(/WHERE id = \$1 AND user_id = \$2 AND EXISTS/);
    const match = text.match(ACTIVE_OWNER_SQL);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2');
    expect(params).toEqual([ID, OWNER, 'Скан договора', '3']);
  });

  it('неактивный владелец неотличим от несуществующего файла: тот же NotFound, то же сообщение, тишина в журнале', async () => {
    // В обоих случаях UPDATE не задел ни одной строки: так база отвечает и на
    // чужой/несуществующий id, и на файл удалённого аккаунта.
    const inactive = await service
      .setNote({ id: ID, userId: OWNER, note: 'текст', assistantId: '3' })
      .then(() => null, (e) => e);
    const missing = await service
      .setNote({ id: '88888888-8888-4888-8888-888888888888', userId: OWNER, note: 'текст', assistantId: '3' })
      .then(() => null, (e) => e);

    expect(inactive).toBeInstanceOf(NotFoundException);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(inactive.message).toBe(missing.message);
    expect(inactive.getStatus()).toBe(missing.getStatus());
    expect(inactive.getResponse()).toEqual(missing.getResponse());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
