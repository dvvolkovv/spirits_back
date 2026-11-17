import 'reflect-metadata';
import { Readable } from 'stream';
import { Logger, NotFoundException } from '@nestjs/common';
import { LanguageService } from '../../common/services/language.service';
import { PgService } from '../../common/services/pg.service';
import { StorageService } from '../../common/services/storage.service';
import { ChatUploadDeleteError, ChatUploadsService } from './chat-uploads.service';
import { deletedUploadLine } from './deleted-line';
import { uploadHistoryLink } from './markdown-name';
import { uploadThumbKey } from './upload-thumb';

/**
 * Удаление загрузки владельцем и миниатюра для панели (спека
 * 2026-11-16-chat-uploads-media-notes-design.md, раздел 1 «Удаление файла»).
 *
 * Контракт deleteForOwner:
 *  - только владелец: чужой/несуществующий id — NotFoundException, MinIO и
 *    записи в БД не трогаются (404 без раскрытия, есть ли запись);
 *  - сначала объекты MinIO (миниатюры — по thumb_key и по вычисляемому
 *    thumbs/<storage_key>.webp, затем оригинал; 'absent' — успех), потом
 *    DELETE строки, потом переписывание строки 📎 в истории сессии;
 *  - любой иной исход MinIO — ChatUploadDeleteError, строка и история целы,
 *    повтор безопасен.
 * Настоящий SQL (strpos, replace, язык профиля) — chat-uploads.delete.pg.spec.ts.
 */

const BUCKET = 'linkeon-chat-uploads';
const RECORD_ID = '33333333-3333-4333-8333-333333333333';
const OWNER = 'owner1';
const SESSION = 'owner1_12';
// Скобки в имени — ради экранирования: история хранит имя через
// markdownEscapeName, и подстрока для replace обязана совпасть посимвольно.
const NAME = 'Гостиная [1].jpg';
const KEY = 'k-1/gostinaya.jpg';
const THUMB = 'thumbs/k-1/gostinaya.jpg.webp';
const HISTORY_SQL =
  'UPDATE custom_chat_history SET content = replace(content, $2, $3) WHERE session_id = $1 AND strpos(content, $2) > 0';

const recordRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: RECORD_ID,
  user_id: OWNER,
  session_id: SESSION,
  original_name: NAME,
  mime: 'image/jpeg',
  size_bytes: 5,
  sha256: 'c'.repeat(64),
  storage_key: KEY,
  created_at: new Date('2026-11-16T10:00:00Z'),
  source: 'web',
  thumb_key: THUMB,
  note: null,
  note_updated_at: null,
  note_assistant_id: null,
  ...extra,
});

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

function makeHarness(
  opts: { row?: Record<string, unknown> | null; lang?: string; withLanguage?: boolean } = {},
) {
  const row = opts.row === undefined ? recordRow() : opts.row;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pg = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const s = norm(sql);
      queries.push({ sql: s, params });
      if (s.startsWith('SELECT')) {
        // Семантика WHERE id = $1 AND user_id = $2: чужому строка не видна.
        // openDownload выбирает по одному id (владельца проверяет сам).
        const byOwner = s.includes('user_id = $2');
        const hit = !!row && params[0] === row.id && (!byOwner || params[1] === row.user_id);
        return { rows: hit ? [row] : [], rowCount: hit ? 1 : 0 };
      }
      if (s.startsWith('DELETE FROM chat_uploads')) return { rows: [], rowCount: 1 };
      if (s.startsWith('UPDATE custom_chat_history')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${s}`);
    }),
  };
  const storage = {
    deleteConfirmed: jest.fn(
      async (_input: { bucket: string; key: string }): Promise<'deleted' | 'absent'> => 'deleted',
    ),
    delete: jest.fn(async (_input: { bucket: string; key: string }): Promise<void> => undefined),
    download: jest.fn(async (_input: { bucket: string; key: string }) => Buffer.from('webp-bytes')),
    downloadStream: jest.fn(async (_input: { bucket: string; key: string }) => Readable.from(['original'])),
  };
  const language = { resolveUserLanguage: jest.fn(async (_userId: string) => opts.lang ?? 'en') };
  const service =
    opts.withLanguage === false
      ? new ChatUploadsService(pg as any, storage as any)
      : new ChatUploadsService(pg as any, storage as any, language as any);
  const writes = () => queries.filter((q) => !q.sql.startsWith('SELECT'));
  return { pg, storage, language, service, queries, writes };
}

/** Все строки журнала сервиса (любой уровень) — для проверок приватности. */
function captureLogs(service: ChatUploadsService): () => string[] {
  const logger = (service as unknown as { logger: Logger }).logger;
  const lines: string[] = [];
  for (const level of ['error', 'warn', 'log', 'debug', 'verbose'] as const) {
    jest.spyOn(logger, level).mockImplementation((message: unknown) => {
      lines.push(String(message));
    });
  }
  return () => lines;
}

async function readAll(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('ChatUploadsService.deleteForOwner', () => {
  it('не владелец — NotFoundException; ни MinIO, ни записи в БД', async () => {
    const { service, storage, writes } = makeHarness();

    await expect(service.deleteForOwner({ id: RECORD_ID, userId: 'intruder' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('несуществующий id — NotFoundException; не-UUID — даже без запроса к БД', async () => {
    const missing = makeHarness({ row: null });
    await expect(missing.service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(missing.storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(missing.writes()).toEqual([]);

    const garbage = makeHarness();
    await expect(garbage.service.deleteForOwner({ id: 'not-a-uuid', userId: OWNER })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(garbage.pg.query).not.toHaveBeenCalled();
  });

  it('владелец: SELECT по id и user_id → миниатюра → оригинал → DELETE строки → UPDATE истории', async () => {
    const { service, storage, pg, queries } = makeHarness();
    // thumb_key совпадает с вычисляемым ключом — Set схлопывает дубликат,
    // миниатюра удаляется одним вызовом.
    expect(THUMB).toBe(uploadThumbKey(KEY));

    await expect(service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).resolves.toBeUndefined();

    expect(storage.deleteConfirmed.mock.calls.map((call) => call[0])).toEqual([
      { bucket: BUCKET, key: THUMB },
      { bucket: BUCKET, key: KEY },
    ]);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(queries).toHaveLength(3);
    expect(queries[0].sql).toMatch(/^SELECT .+ FROM chat_uploads WHERE id = \$1 AND user_id = \$2$/);
    expect(queries[0].params).toEqual([RECORD_ID, OWNER]);
    expect(queries[1]).toEqual({
      sql: 'DELETE FROM chat_uploads WHERE id = $1 AND user_id = $2',
      params: [RECORD_ID, OWNER],
    });
    expect(queries[2].sql).toBe(HISTORY_SQL);
    // Строка уходит только ПОСЛЕ подтверждённого удаления обоих объектов.
    const lastObject = Math.max(...storage.deleteConfirmed.mock.invocationCallOrder);
    expect(lastObject).toBeLessThan(pg.query.mock.invocationCallOrder[1]);
  });

  it('UPDATE истории: точный текст и параметры — ссылка как у chat.controller, замена на языке профиля', async () => {
    const { service, queries, language } = makeHarness({ lang: 'en' });

    await service.deleteForOwner({ id: RECORD_ID, userId: OWNER });

    const update = queries[queries.length - 1];
    expect(update.sql).toBe(HISTORY_SQL);
    expect(update.params).toEqual([
      SESSION,
      `📎 [Гостиная \\[1\\].jpg](/webhook/chat-uploads/${RECORD_ID})`,
      '📎 Гостиная [1].jpg — file deleted',
    ]);
    // Та же сборка, что пишет chat.controller.ts (общий uploadHistoryLink),
    // и та же строка, что отдаёт deleted-line.ts.
    expect(update.params[1]).toBe(uploadHistoryLink(NAME, `/webhook/chat-uploads/${RECORD_ID}`));
    expect(update.params[2]).toBe(deletedUploadLine(NAME, 'en'));
    expect(language.resolveUserLanguage).toHaveBeenCalledWith(OWNER);
  });

  // Искомая строка — посимвольно та, что записал upload-and-chat (сырое имя
  // через uploadHistoryLink), иначе replace её не найдёт. Замена — для глаз
  // человека: имя через safeFileName, RLO и невидимые символы в пузырь не идут.
  it('имя с RLO: ищется сырая строка истории, в замене — очищенное имя', async () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const rawName = `счёт${rlo}fdp.exe${zwsp}`;
    const { service, queries } = makeHarness({ row: recordRow({ original_name: rawName }), lang: 'en' });

    await service.deleteForOwner({ id: RECORD_ID, userId: OWNER });

    const update = queries[queries.length - 1];
    expect(update.sql).toBe(HISTORY_SQL);
    expect(update.params[1]).toBe(uploadHistoryLink(rawName, `/webhook/chat-uploads/${RECORD_ID}`));
    expect(update.params[1]).toContain(rlo);
    expect(update.params[2]).toBe('📎 счётfdp.exe — file deleted');
    expect(update.params[2]).not.toContain(rlo);
    expect(update.params[2]).not.toContain(zwsp);
  });

  it('без LanguageService — строка «файл удалён» по-русски', async () => {
    const { service, queries } = makeHarness({ withLanguage: false });

    await service.deleteForOwner({ id: RECORD_ID, userId: OWNER });

    expect(queries[queries.length - 1].params[2]).toBe('📎 Гостиная [1].jpg — файл удалён');
  });

  it('LanguageService упал — история всё равно переписывается, по-русски', async () => {
    const { service, language, writes } = makeHarness({ lang: 'en' });
    language.resolveUserLanguage.mockRejectedValueOnce(new Error('db down'));

    await expect(service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).resolves.toBeUndefined();

    const all = writes();
    expect(all.map((q) => q.sql.slice(0, 6))).toEqual(['DELETE', 'UPDATE']);
    expect(all[1].params[2]).toBe('📎 Гостиная [1].jpg — файл удалён');
  });

  it('thumb_key NULL — всё равно пробует thumbs/<KEY>.webp (absent терпимо), затем оригинал', async () => {
    // Неоднозначный сбой загрузки миниатюры при сохранении: объект мог лечь
    // в бакет, а thumb_key остался NULL. Удаление стирает и его.
    const { service, storage, writes } = makeHarness({ row: recordRow({ thumb_key: null }) });
    storage.deleteConfirmed.mockResolvedValueOnce('absent');

    await expect(service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).resolves.toBeUndefined();

    expect(storage.deleteConfirmed.mock.calls.map((call) => call[0])).toEqual([
      { bucket: BUCKET, key: `thumbs/${KEY}.webp` },
      { bucket: BUCKET, key: KEY },
    ]);
    expect(writes()).toHaveLength(2);
  });

  it('thumb_key не совпадает с вычисляемым — стираются оба ключа миниатюры, затем оригинал', async () => {
    const OTHER_THUMB = 'thumbs/legacy/other.webp';
    const { service, storage } = makeHarness({ row: recordRow({ thumb_key: OTHER_THUMB }) });

    await service.deleteForOwner({ id: RECORD_ID, userId: OWNER });

    expect(storage.deleteConfirmed.mock.calls.map((call) => call[0])).toEqual([
      { bucket: BUCKET, key: OTHER_THUMB },
      { bucket: BUCKET, key: uploadThumbKey(KEY) },
      { bucket: BUCKET, key: KEY },
    ]);
  });

  it('объекта уже нет (absent) — терпимо: строка удаляется, история переписывается', async () => {
    const { service, storage, writes } = makeHarness();
    storage.deleteConfirmed.mockResolvedValue('absent');

    await expect(service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).resolves.toBeUndefined();

    expect(writes().map((q) => q.sql.slice(0, 6))).toEqual(['DELETE', 'UPDATE']);
  });

  it('иной сбой MinIO на миниатюре — ChatUploadDeleteError; до оригинала не дошли, строка и история целы', async () => {
    const { service, storage, writes } = makeHarness();
    storage.deleteConfirmed.mockRejectedValueOnce(
      Object.assign(new Error('We encountered an internal error'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      }),
    );

    await expect(service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).rejects.toBeInstanceOf(
      ChatUploadDeleteError,
    );
    expect(storage.deleteConfirmed).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);
  });

  it('сбой на оригинале после удалённой миниатюры — ChatUploadDeleteError; повтор проходит', async () => {
    const { service, storage, writes } = makeHarness();
    storage.deleteConfirmed
      .mockResolvedValueOnce('deleted')
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }));

    await expect(service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).rejects.toBeInstanceOf(
      ChatUploadDeleteError,
    );
    expect(writes()).toEqual([]);

    // Повтор: миниатюры уже нет (absent), оригинал удаляется — успех.
    storage.deleteConfirmed.mockResolvedValueOnce('absent').mockResolvedValueOnce('deleted');
    await expect(service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).resolves.toBeUndefined();
    expect(writes().map((q) => q.sql.slice(0, 6))).toEqual(['DELETE', 'UPDATE']);
  });

  it('ChatUploadDeleteError — экспортируемый Error без имени файла и ключей в сообщении', async () => {
    const { service, storage } = makeHarness();
    storage.deleteConfirmed.mockRejectedValueOnce(new Error(`boom ${KEY}`));

    const error = await service.deleteForOwner({ id: RECORD_ID, userId: OWNER }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChatUploadDeleteError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('ChatUploadDeleteError');
    expect((error as Error).message).not.toContain(NAME);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('сбой UPDATE истории не превращает удаление в ошибку: файл уже стёрт, повтор дал бы 404', async () => {
    const { service, pg, writes } = makeHarness();
    const base = pg.query.getMockImplementation()!;
    pg.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (norm(sql).startsWith('UPDATE custom_chat_history')) throw new Error('db down');
      return base(sql, params);
    });

    await expect(service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).resolves.toBeUndefined();
    expect(writes().map((q) => q.sql.slice(0, 6))).toEqual(['DELETE']);
  });

  it('DI: третий параметр конструктора — настоящий LanguageService (value-импорт, не import type)', () => {
    expect(Reflect.getMetadata('design:paramtypes', ChatUploadsService)).toEqual([
      PgService,
      StorageService,
      LanguageService,
    ]);
  });
});

describe('ChatUploadsService.openThumb', () => {
  it('владельцу — webp из thumb_key целиком, размер по байтам', async () => {
    const { service, storage } = makeHarness();

    const file = await service.openThumb({ id: RECORD_ID, userId: OWNER });

    expect(storage.download).toHaveBeenCalledWith({ bucket: BUCKET, key: THUMB });
    expect(storage.downloadStream).not.toHaveBeenCalled();
    expect(file).toMatchObject({
      originalName: NAME,
      mime: 'image/webp',
      sizeBytes: Buffer.byteLength('webp-bytes'),
    });
    expect(await readAll(file.body)).toBe('webp-bytes');
  });

  it('не владелец, нет записи, нет thumb_key, не-UUID — NotFoundException без чтения MinIO', async () => {
    const cases: Array<{ h: ReturnType<typeof makeHarness>; input: { id: string; userId: string } }> = [
      { h: makeHarness(), input: { id: RECORD_ID, userId: 'intruder' } },
      { h: makeHarness({ row: null }), input: { id: RECORD_ID, userId: OWNER } },
      { h: makeHarness({ row: recordRow({ thumb_key: null }) }), input: { id: RECORD_ID, userId: OWNER } },
      { h: makeHarness(), input: { id: 'not-a-uuid', userId: OWNER } },
    ];
    for (const { h, input } of cases) {
      await expect(h.service.openThumb(input)).rejects.toBeInstanceOf(NotFoundException);
      expect(h.storage.download).not.toHaveBeenCalled();
    }
  });

  it('объекта миниатюры нет в MinIO — тот же NotFoundException, а не 500', async () => {
    const { service, storage } = makeHarness();
    storage.download.mockRejectedValueOnce(
      Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' }),
    );

    await expect(service.openThumb({ id: RECORD_ID, userId: OWNER })).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * Журнал сервиса — без имени файла и ключей объектов: ключ — это
 * `<uuid>/<safeFileName(имя)>`, а текст ошибок S3/pg может его повторять.
 * В журнал идёт только вид ошибки (name, HTTP-статус S3, код pg/системы);
 * id запроса — в кавычках, без сырых переводов строки.
 */
describe('ChatUploadsService: журнал без имён файлов и ключей', () => {
  it('сбой удаления в MinIO — вид ошибки и статус, без имени файла, ключа и текста сообщения', async () => {
    const { service, storage } = makeHarness();
    const logs = captureLogs(service);
    storage.deleteConfirmed.mockRejectedValueOnce(
      Object.assign(new Error(`boom ${KEY} ${NAME}`), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      }),
    );

    await expect(service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).rejects.toBeInstanceOf(
      ChatUploadDeleteError,
    );

    const text = logs().join('\n');
    expect(text).toContain('InternalError');
    expect(text).toContain('500');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(NAME);
    expect(text).not.toContain('boom');
  });

  it('сбой UPDATE истории — вид ошибки и SQLSTATE, без имени файла и текста сообщения', async () => {
    const { service, pg } = makeHarness();
    const logs = captureLogs(service);
    const base = pg.query.getMockImplementation()!;
    pg.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (norm(sql).startsWith('UPDATE custom_chat_history')) {
        throw Object.assign(new Error(`value too long near "${NAME}"`), { name: 'error', code: '22001' });
      }
      return base(sql, params);
    });

    await expect(service.deleteForOwner({ id: RECORD_ID, userId: OWNER })).resolves.toBeUndefined();

    const text = logs().join('\n');
    expect(text).toContain('22001');
    expect(text).not.toContain(NAME);
    expect(text).not.toContain('value too long');
  });

  it('openThumb: сбой MinIO — 404, в журнале вид ошибки без ключа миниатюры', async () => {
    const { service, storage } = makeHarness();
    const logs = captureLogs(service);
    storage.download.mockRejectedValueOnce(
      Object.assign(new Error(`read ${THUMB} failed`), { name: 'TimeoutError', code: 'ETIMEDOUT' }),
    );

    await expect(service.openThumb({ id: RECORD_ID, userId: OWNER })).rejects.toBeInstanceOf(NotFoundException);

    const text = logs().join('\n');
    expect(text).toContain('TimeoutError');
    expect(text).toContain('ETIMEDOUT');
    expect(text).not.toContain(THUMB);
    expect(text).not.toContain(KEY);
  });

  it('openDownload: сбой MinIO — 404, в журнале вид ошибки и статус без ключа', async () => {
    const { service, storage } = makeHarness();
    const logs = captureLogs(service);
    storage.downloadStream.mockRejectedValueOnce(
      Object.assign(new Error(`GetObject ${KEY}`), {
        name: 'ServiceUnavailable',
        $metadata: { httpStatusCode: 503 },
      }),
    );

    await expect(service.openDownload({ id: RECORD_ID, userId: OWNER })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const text = logs().join('\n');
    expect(text).toContain('ServiceUnavailable');
    expect(text).toContain('503');
    expect(text).not.toContain(KEY);
  });

  it('id запроса в журнале — в кавычках, перевод строки не подделает запись', async () => {
    const { service } = makeHarness();
    const logs = captureLogs(service);
    const forged = 'x\n[Nest] 1  - FAKE LOG LINE';

    await expect(service.openThumb({ id: forged, userId: OWNER })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.openDownload({ id: forged, userId: OWNER })).rejects.toBeInstanceOf(NotFoundException);

    expect(logs()).toHaveLength(2);
    for (const line of logs()) {
      expect(line).not.toContain('\n');
      expect(line).toContain(JSON.stringify(forged));
    }
  });
});
