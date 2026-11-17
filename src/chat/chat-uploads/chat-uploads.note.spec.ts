import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ChatUploadsService } from './chat-uploads.service';

/**
 * Комментарий ассистента к загрузке (note_file, spec 2026-11-16, раздел 2):
 * пишется только в строку владельца, 1..500 символов после trim, новый
 * заменяет прежний вместе со временем и ассистентом хода.
 */
describe('ChatUploadsService.setNote: комментарий ассистента', () => {
  const pg = { query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as any[] })) };
  const service = new ChatUploadsService(pg as any, {} as any);
  const ID = '55555555-5555-4555-8555-555555555555';

  /** Строка, которую вернёт UPDATE … RETURNING — синтетика, без реальных данных. */
  const savedRow = (note: string, assistantId: string | null) => ({
    id: ID,
    user_id: 'owner1',
    session_id: 'owner1_3',
    original_name: 'гостиная.jpg',
    mime: 'image/jpeg',
    size_bytes: 4096,
    sha256: 'd'.repeat(64),
    storage_key: 'k-5/gostinaya.jpg',
    created_at: new Date('2026-11-16T09:00:00.000Z'),
    source: 'web',
    thumb_key: 'thumbs/k-5/gostinaya.jpg.webp',
    note,
    note_updated_at: '2026-11-16T10:00:00.000Z',
    note_assistant_id: assistantId,
  });

  beforeEach(() => pg.query.mockClear());

  it('обрезает пробелы и пишет комментарий, время и ассистента — только в строку владельца', async () => {
    pg.query.mockResolvedValueOnce({ rows: [savedRow('Фото гостиной: серый диван.', '3')] });
    const record = await service.setNote({
      id: ID,
      userId: 'owner1',
      note: '  Фото гостиной: серый диван.\n',
      assistantId: '3',
    });

    expect(pg.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pg.query.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE chat_uploads/);
    expect(String(sql)).toMatch(/note_updated_at = now\(\)/);
    expect(String(sql)).toMatch(/WHERE id = \$1 AND user_id = \$2/);
    expect(String(sql)).toMatch(/RETURNING/);
    expect(params).toEqual([ID, 'owner1', 'Фото гостиной: серый диван.', '3']);
    expect(record).toMatchObject({
      id: ID,
      note: 'Фото гостиной: серый диван.',
      noteUpdatedAt: '2026-11-16T10:00:00.000Z',
      noteAssistantId: '3',
    });
  });

  it('ассистент неизвестен — note_assistant_id = NULL', async () => {
    pg.query.mockResolvedValueOnce({ rows: [savedRow('Договор аренды, подписан.', null)] });
    const record = await service.setNote({ id: ID, userId: 'owner1', note: 'Договор аренды, подписан.', assistantId: null });
    expect(pg.query.mock.calls[0][1]).toEqual([ID, 'owner1', 'Договор аренды, подписан.', null]);
    expect(record.noteAssistantId).toBeNull();
  });

  it('пустой комментарий, одни пробелы или не строка — BadRequest, в базу не ходим', async () => {
    await expect(service.setNote({ id: ID, userId: 'owner1', note: '', assistantId: '3' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setNote({ id: ID, userId: 'owner1', note: '  \n\t ', assistantId: '3' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setNote({ id: ID, userId: 'owner1', note: undefined as any, assistantId: '3' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('длина — в символах, как char_length в CHECK: 500 можно, 501 — BadRequest', async () => {
    // Эмодзи — две единицы UTF-16 в JS, но один символ в Postgres.
    const fiveHundred = '😀'.repeat(500);
    pg.query.mockResolvedValueOnce({ rows: [savedRow(fiveHundred, '3')] });
    await expect(service.setNote({ id: ID, userId: 'owner1', note: fiveHundred, assistantId: '3' }))
      .resolves.toMatchObject({ note: fiveHundred });
    await expect(service.setNote({ id: ID, userId: 'owner1', note: 'я'.repeat(501), assistantId: '3' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('чужой или несуществующий файл — NotFound (UPDATE не задел ни одной строки)', async () => {
    pg.query.mockResolvedValueOnce({ rows: [] });
    await expect(service.setNote({ id: ID, userId: 'intruder', note: 'чужой файл', assistantId: '3' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(pg.query.mock.calls[0][1]).toEqual([ID, 'intruder', 'чужой файл', '3']);
  });

  it('id не UUID — NotFound без обращения к базе', async () => {
    await expect(service.setNote({ id: 'not-a-uuid', userId: 'owner1', note: 'текст', assistantId: '3' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(pg.query).not.toHaveBeenCalled();
  });
});
