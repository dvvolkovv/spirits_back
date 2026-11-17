import { createHash } from 'crypto';
import { Readable } from 'stream';
import { NotFoundException } from '@nestjs/common';
import { ChatUploadsService } from './chat-uploads.service';

describe('ChatUploadsService', () => {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const storage = {
    upload: jest.fn(async () => 'https://public.invalid/should-not-be-used'),
    delete: jest.fn(async () => {}),
    createBucketIfAbsent: jest.fn(async () => {}),
    downloadStream: jest.fn(async () => Readable.from(['bytes'])),
  };
  const service = new ChatUploadsService(pg as any, storage as any);

  const ENV_KEYS = ['JWT_SECRET', 'BACKEND_URL', 'CHAT_UPLOADS_ENABLED'] as const;
  let envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    envSnapshot = {};
    for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
    process.env.JWT_SECRET = 'spec-secret';
    process.env.BACKEND_URL = 'https://my.linkeon.test';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const saved = envSnapshot[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  it('сохраняет байты и запись без публичной ссылки', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: '11111111-1111-4111-8111-111111111111', user_id: 'u1', session_id: 'u1_12', original_name: 'a.pdf', mime: 'application/pdf', size_bytes: 3, sha256: createHash('sha256').update('abc').digest('hex'), storage_key: 'k/a.pdf', created_at: new Date('2026-01-01') }] });
    const result = await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: [{ buffer: Buffer.from('abc'), originalname: 'a.pdf', mimetype: 'application/pdf' }] });
    expect(result.saved[0]).toMatchObject({ originalName: 'a.pdf', sizeBytes: 3 });
    expect(result.failed).toEqual([]);
    expect(storage.upload.mock.calls[0][0].bucket).toBe('linkeon-chat-uploads');
    expect(JSON.stringify(result)).not.toContain('public.invalid');
  });

  it('при ошибке записи удаляет объект тем же ключом и возвращает failed', async () => {
    pg.query.mockRejectedValueOnce(new Error('db down'));
    const result = await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: [{ buffer: Buffer.from('x'), originalname: 'x.txt' }] });
    expect(result.failed).toEqual(['x.txt']);
    expect(storage.delete).toHaveBeenCalled();
    const uploadedKey = storage.upload.mock.calls[0][0].key;
    expect(storage.delete.mock.calls[0][0].key).toBe(uploadedKey);
  });

  it('подпись живёт час и не принимает чужую/просроченную', () => {
    const url = service.assistantUrl('11111111-1111-4111-8111-111111111111', 1000);
    expect(url).toContain('exp=4600');
    expect(service.verifyAssistant('11111111-1111-4111-8111-111111111111', '4600', url.split('sig=')[1], 1000)).toBe(true);
    expect(service.verifyAssistant('11111111-1111-4111-8111-111111111111', '4600', 'bad', 1000)).toBe(false);
    expect(service.verifyAssistant('11111111-1111-4111-8111-111111111111', '4600', url.split('sig=')[1], 4601)).toBe(false);
  });

  it('блок ассистента пуст при выключенном флаге и подписан при включённом', () => {
    const record = {
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'u1',
      sessionId: 'u1_12',
      originalName: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
      storageKey: 'k/a.pdf',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    process.env.CHAT_UPLOADS_ENABLED = 'false';
    expect(service.assistantBlock([record])).toBe('');

    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const block = service.assistantBlock([record]);
    expect(block).toContain('Earlier user uploads:');
    // Формат строки файла (B4): id, имя, вид, дата, комментарий; подписанная
    // ссылка — следующей строкой с отступом.
    expect(block).toContain(`- id=${record.id} | a.pdf | document | 2026-01-01 | комментарий: нет — оставь его через note_file после работы с файлом`);
    expect(block).toContain(`\n  https://my.linkeon.test/webhook/chat-uploads/${record.id}?exp=`);
    expect(block).toMatch(/\?exp=\d+&sig=[0-9a-f]{64}$/);
    // I1a (ревью Task 6): в resumed-сессиях релея накапливаются устаревшие
    // копии блока; модель обязана брать ссылки только из ПОСЛЕДНЕЙ копии и
    // знать, что ссылка живёт около часа.
    expect(block).toContain('1 hour');
    expect(block).toMatch(/ONLY the (LATEST|latest)/);
    // I2 (ревью): явный запрет в заголовке — подписанный адрес только для
    // модели; пользователю файл отдаётся через url из find_files.
    expect(block).toContain('NEVER show');
    expect(block).toContain('find_files');
  });

  it('searchOriginals ограничивает выдачу 200 строками', async () => {
    await service.searchOriginals('u1', 7);
    const sql = String(pg.query.mock.calls[0][0]);
    expect(sql).toMatch(/ORDER BY created_at DESC\s+LIMIT 200/);
  });

  it('createBucketIfAbsent вызывается не чаще раза на процесс', async () => {
    const fresh = new ChatUploadsService(pg as any, storage as any);
    await fresh.saveOriginals({ userId: 'u1', sessionId: 'u1_1', files: [] });
    await fresh.saveOriginals({ userId: 'u1', sessionId: 'u1_1', files: [] });
    expect(storage.createBucketIfAbsent).toHaveBeenCalledTimes(1);
  });

  describe('openDownload', () => {
    const RECORD_ID = '22222222-2222-4222-8222-222222222222';
    const recordRow = () => ({
      id: RECORD_ID,
      user_id: 'owner1',
      session_id: 'owner1_1',
      original_name: 'doc.pdf',
      mime: 'application/pdf',
      size_bytes: 11,
      sha256: 'b'.repeat(64),
      storage_key: 'k/doc.pdf',
      created_at: new Date('2026-01-02'),
    });

    it('владельцу отдаёт поток, имя, mime и размер', async () => {
      pg.query.mockResolvedValueOnce({ rows: [recordRow()] });
      const download = await service.openDownload({ id: RECORD_ID, userId: 'owner1' });
      expect(download).toMatchObject({ originalName: 'doc.pdf', mime: 'application/pdf', sizeBytes: 11 });
      expect(download.body).toBeInstanceOf(Readable);
      expect(storage.downloadStream).toHaveBeenCalledWith({ bucket: 'linkeon-chat-uploads', key: 'k/doc.pdf' });
    });

    it('чужому userId без валидной подписи — 404', async () => {
      pg.query.mockResolvedValueOnce({ rows: [recordRow()] });
      await expect(service.openDownload({ id: RECORD_ID, userId: 'intruder' })).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.downloadStream).not.toHaveBeenCalled();
    });

    it('валидные exp+sig без userId открывают файл', async () => {
      pg.query.mockResolvedValueOnce({ rows: [recordRow()] });
      const url = new URL(service.assistantUrl(RECORD_ID, Date.now() / 1000));
      const exp = url.searchParams.get('exp') as string;
      const sig = url.searchParams.get('sig') as string;
      const download = await service.openDownload({ id: RECORD_ID, exp, sig });
      expect(download.originalName).toBe('doc.pdf');
    });

    it('просроченная подпись — 404', async () => {
      pg.query.mockResolvedValueOnce({ rows: [recordRow()] });
      const url = new URL(service.assistantUrl(RECORD_ID, Date.now() / 1000 - 7200));
      const exp = url.searchParams.get('exp') as string;
      const sig = url.searchParams.get('sig') as string;
      await expect(service.openDownload({ id: RECORD_ID, exp, sig })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('неверная подпись — 404', async () => {
      pg.query.mockResolvedValueOnce({ rows: [recordRow()] });
      const exp = String(Math.floor(Date.now() / 1000) + 600);
      await expect(service.openDownload({ id: RECORD_ID, exp, sig: 'f'.repeat(64) })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('несуществующая запись — 404', async () => {
      pg.query.mockResolvedValueOnce({ rows: [] });
      await expect(service.openDownload({ id: RECORD_ID, userId: 'owner1' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('невалидный (не UUID) id — 404 без обращения к pg', async () => {
      await expect(service.openDownload({ id: 'not-a-uuid', userId: 'owner1' })).rejects.toBeInstanceOf(NotFoundException);
      expect(pg.query).not.toHaveBeenCalled();
    });
  });

  // deleteForUser удалён из сервиса (Phase 2): очистку chat_uploads при
  // удалении аккаунта делает конвейер — chat-upload-account-deletion.adapter.ts
  // (fencing + deleteConfirmed), покрытие — в адаптерных спеках.
});

describe('ChatUploadsService: поля миграции 002 (source, миниатюра, комментарий)', () => {
  const pg = { query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as any[] })) };
  const service = new ChatUploadsService(pg as any, {} as any);

  const baseRow = {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: 'u1',
    session_id: 'u1_12',
    original_name: 'гостиная.png',
    mime: 'image/png',
    size_bytes: 2048,
    sha256: 'c'.repeat(64),
    storage_key: 'k-3/gostinaya.png',
    created_at: new Date('2026-11-16T09:00:00.000Z'),
  };

  beforeEach(() => pg.query.mockClear());

  it('COLUMNS читает новые поля из реестра', async () => {
    await service.recentForSession('u1', 'u1_12');
    const sql = String(pg.query.mock.calls[0][0]);
    for (const column of ['source', 'thumb_key', 'note', 'note_updated_at', 'note_assistant_id']) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it('row() переносит заполненные поля: source, thumbKey, note, noteUpdatedAt (ISO), noteAssistantId', async () => {
    pg.query.mockResolvedValueOnce({
      rows: [{
        ...baseRow,
        source: 'scan',
        thumb_key: 'thumbs/k-3/gostinaya.png.webp',
        note: 'Фото гостиной: три окна, светлый пол',
        note_updated_at: new Date('2026-11-16T10:00:00.000Z'),
        note_assistant_id: '7',
      }],
    });
    const [record] = await service.recentForSession('u1', 'u1_12');
    expect(record).toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      userId: 'u1',
      sessionId: 'u1_12',
      originalName: 'гостиная.png',
      mime: 'image/png',
      sizeBytes: 2048,
      sha256: 'c'.repeat(64),
      storageKey: 'k-3/gostinaya.png',
      createdAt: '2026-11-16T09:00:00.000Z',
      source: 'scan',
      thumbKey: 'thumbs/k-3/gostinaya.png.webp',
      note: 'Фото гостиной: три окна, светлый пол',
      noteUpdatedAt: '2026-11-16T10:00:00.000Z',
      noteAssistantId: '7',
    });
  });

  it('row(): NULL остаются null (не строкой "null"), source без значения — web', async () => {
    pg.query.mockResolvedValueOnce({
      rows: [
        { ...baseRow, source: 'web', thumb_key: null, note: null, note_updated_at: null, note_assistant_id: null },
        { ...baseRow, id: '44444444-4444-4444-8444-444444444444' },
      ],
    });
    const [withNulls, withoutColumns] = await service.recentForSession('u1', 'u1_12');
    expect(withNulls).toMatchObject({
      source: 'web',
      thumbKey: null,
      note: null,
      noteUpdatedAt: null,
      noteAssistantId: null,
    });
    // Строка без новых колонок (моки соседних спеков, старая форма выборки).
    expect(withoutColumns).toMatchObject({
      source: 'web',
      thumbKey: null,
      note: null,
      noteUpdatedAt: null,
      noteAssistantId: null,
    });
  });
});
