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

  it('пустой userId — NotFound без обращения к базе', async () => {
    await expect(service.setNote({ id: ID, userId: '', note: 'текст', assistantId: '3' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(pg.query).not.toHaveBeenCalled();
  });

  /**
   * Чистка до trim и подсчёта: Postgres не примет NUL в text (22021) — в B3
   * модель получила бы сырую ошибку; прочие управляющие и bidi-переопределения
   * — мусор и подмена порядка символов в подсказке. Многострочность остаётся.
   */
  describe('чистка комментария', () => {
    it('NUL, прочие C0, DEL и C1 вырезаются и до UPDATE не доходят; \\t и \\n остаются', async () => {
      pg.query.mockResolvedValueOnce({ rows: [savedRow('Чек за май', '3')] });
      await service.setNote({
        id: ID,
        userId: 'owner1',
        note: 'Чек\u0000 за\u0007\u001B май\u007F\u0085\u009F\tитог\nстрока',
        assistantId: '3',
      });
      const saved = pg.query.mock.calls[0][1]![2] as string;
      expect(saved).toBe('Чек за май\tитог\nстрока');
      expect(saved).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    });

    it('строка из одних управляющих и bidi-символов — BadRequest, в базу не ходим', async () => {
      for (const note of [
        '\u0000\u0001\u001B\u007F\u0085\u009F',
        '\u202E\u2066 \u2069',
        '\r\n\u0000\t\u000B\u000C',
      ]) {
        await expect(service.setNote({ id: ID, userId: 'owner1', note, assistantId: '3' }))
          .rejects.toBeInstanceOf(BadRequestException);
      }
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('bidi-переопределения и изоляты вырезаются, ZWJ в эмодзи остаётся', async () => {
      pg.query.mockResolvedValueOnce({ rows: [savedRow('x', '3')] });
      await service.setNote({
        id: ID,
        userId: 'owner1',
        note: 'счёт\u202Egpj.exe \u2066имя\u2069 \u202A\u202B\u202C\u202D\u2067\u2068 👩\u200D💻',
        assistantId: '3',
      });
      expect(pg.query.mock.calls[0][1]![2]).toBe('счётgpj.exe имя  👩\u200D💻');
    });

    /**
     * Невидимые символы формата (\p{Cf}) — кроме ZWJ, который склеивает
     * эмодзи: теги U+E0000–E007F прячут в комментарии текст, который модель
     * прочтёт, а человек не увидит; ZWSP, LRM/RLM, WJ, BOM и якоря
     * аннотаций U+FFF9–FFFB — невидимый мусор. Строим их из кодов, чтобы в
     * исходнике не было ни одного сырого невидимого символа.
     */
    const ZWJ = String.fromCodePoint(0x200d);
    const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    const TAGS = String.fromCodePoint(0xe0001, 0xe0020, 0xe0041, 0xe0062, 0xe007e, 0xe007f);
    const INVISIBLE = String.fromCodePoint(
      0x200b, // ZWSP
      0x200e, // LRM
      0x200f, // RLM
      0x2060, // WJ
      0x2061,
      0x2062,
      0x2063,
      0x2064,
      0xfeff, // BOM
      0xfff9,
      0xfffa,
      0xfffb,
    );
    const cfLeft = (text: string) => Array.from(text).filter((ch) => /\p{Cf}/u.test(ch) && ch !== ZWJ);

    it('невидимые символы формата вырезаются: теги, ZWSP, LRM/RLM, WJ, BOM, U+FFF9; ZWJ в эмодзи остаётся', async () => {
      pg.query.mockResolvedValueOnce({ rows: [savedRow('x', '3')] });
      await service.setNote({
        id: ID,
        userId: 'owner1',
        note: `до${TAGS}по${INVISIBLE}сле ${FAMILY}${TAGS}`,
        assistantId: '3',
      });
      const saved = pg.query.mock.calls[0][1]![2] as string;
      expect(saved).toBe(`допосле ${FAMILY}`);
      expect(cfLeft(saved)).toEqual([]);
      expect(saved).toContain(ZWJ);
    });

    // ZWNJ (U+200C) — часть правописания: в персидском он разделяет
    // приставку и основу внутри слова, в языках Индии управляет лигатурами.
    // Вырезать его — портить текст, как и ZWJ.
    it('ZWNJ внутри слова сохраняется', async () => {
      const zwnj = String.fromCodePoint(0x200c);
      const word = `می${zwnj}خواهم`;
      pg.query.mockResolvedValueOnce({ rows: [savedRow('x', '3')] });
      await service.setNote({ id: ID, userId: 'owner1', note: `${word} ${TAGS}`, assistantId: '3' });
      const saved = pg.query.mock.calls[0][1]![2] as string;
      expect(saved).toBe(word);
      expect(saved).toContain(zwnj);
    });

    it('строка из одних невидимых символов формата — BadRequest, в базу не ходим', async () => {
      for (const note of [TAGS, INVISIBLE, ` ${TAGS}\n${INVISIBLE} `]) {
        await expect(service.setNote({ id: ID, userId: 'owner1', note, assistantId: '3' }))
          .rejects.toBeInstanceOf(BadRequestException);
      }
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('длина считается после чистки: 500 букв и невидимые символы формата — можно', async () => {
      const fiveHundred = 'я'.repeat(500);
      pg.query.mockResolvedValueOnce({ rows: [savedRow(fiveHundred, '3')] });
      await service.setNote({
        id: ID,
        userId: 'owner1',
        note: `${TAGS}${fiveHundred.slice(0, 250)}${INVISIBLE}${fiveHundred.slice(250)}${TAGS}`,
        assistantId: '3',
      });
      expect(pg.query.mock.calls[0][1]![2]).toBe(fiveHundred);
    });

    it('CRLF и одиночный CR становятся LF, строки не склеиваются', async () => {
      pg.query.mockResolvedValueOnce({ rows: [savedRow('x', '3')] });
      await service.setNote({
        id: ID,
        userId: 'owner1',
        note: '\r\nСтрока 1\r\nСтрока 2\rСтрока 3\n\r\n',
        assistantId: '3',
      });
      expect(pg.query.mock.calls[0][1]![2]).toBe('Строка 1\nСтрока 2\nСтрока 3');
    });

    it('длина считается после чистки: 500 букв и управляющие символы — можно', async () => {
      const fiveHundred = 'я'.repeat(500);
      pg.query.mockResolvedValueOnce({ rows: [savedRow(fiveHundred, '3')] });
      await service.setNote({
        id: ID,
        userId: 'owner1',
        note: `\u0000${fiveHundred.slice(0, 250)}\u202E\u0007${fiveHundred.slice(250)}\u0000`,
        assistantId: '3',
      });
      expect(pg.query.mock.calls[0][1]![2]).toBe(fiveHundred);
    });
  });
});
