import { NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { LanguageService } from '../../common/services/language.service';
import { ChatUploadDeleteError, ChatUploadsService } from './chat-uploads.service';
import { deletedUploadLine } from './deleted-line';
import { markdownEscapeName, uploadHistoryLink } from './markdown-name';

/**
 * deleteForOwner против живого Postgres: настоящие миграции 001+002 (через
 * ChatUploadsService.migrate), копия custom_chat_history из
 * base/migrations/001_core_schema.sql и минимальная ai_profiles_consolidated —
 * язык читает настоящий LanguageService.resolveUserLanguage.
 *
 * Своя схема на прогон (search_path — опцией соединения, приём
 * account-deletion.dry-run.spec.ts): соседние pg-спеки делят ту же
 * одноразовую базу и TRUNCATE-ят chat_uploads в public.
 *
 * Главное, чего не видят юнит-тесты: имя с `[`, `]` и `\` лежит в истории
 * экранированным (markdownEscapeName), а в LIKE обратная косая — escape-символ,
 * поэтому фильтр `LIKE '%' || $2 || '%'` такую строку пропустил бы. strpos
 * сравнивает подстроку буквально.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const SCHEMA = `chat_uploads_del_${process.pid}_${Date.now()}`;
const SHA = 'd'.repeat(64);
const OWNER = 'u-del';
const SESSION = 'u-del_12';
// В JS-строке: «Гостиная [1] \ копия.jpg» — квадратные скобки и обратная косая.
const NAME = 'Гостиная [1] \\ копия.jpg';
// Как его хранит история: «Гостиная \[1\] \\ копия.jpg».
const ESCAPED = 'Гостиная \\[1\\] \\\\ копия.jpg';

maybe('deleteForOwner против живого Postgres', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  let service: ChatUploadsService;
  const storage = {
    deleteConfirmed: jest.fn(
      async (_input: { bucket: string; key: string }): Promise<'deleted' | 'absent'> => 'deleted',
    ),
    delete: jest.fn(async (_input: { bucket: string; key: string }): Promise<void> => undefined),
  };
  const db = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]),
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(`CREATE TABLE custom_chat_history (
      id serial PRIMARY KEY,
      session_id text NOT NULL,
      sender_type varchar(10) NOT NULL CHECK (sender_type IN ('ai', 'human')),
      agent integer,
      content text NOT NULL,
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      message_type varchar(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image')),
      tokens_used integer DEFAULT 0)`);
    await pool.query('CREATE TABLE ai_profiles_consolidated (user_id text PRIMARY KEY, profile_data jsonb)');
    service = new ChatUploadsService(db as any, storage as any, new LanguageService(db as any));
    // Настоящий путь старта: 001, затем 002 (thumb_key и др.).
    await service.migrate();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE chat_uploads, custom_chat_history, ai_profiles_consolidated');
    storage.deleteConfirmed.mockReset();
    storage.deleteConfirmed.mockResolvedValue('deleted');
    storage.delete.mockReset();
  });

  async function seedUpload(name: string, key: string, thumbKey: string | null): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO chat_uploads
         (user_id, session_id, original_name, mime, size_bytes, sha256, storage_key, thumb_key)
       VALUES ($1, $2, $3, 'image/jpeg', 10, $4, $5, $6)
       RETURNING id`,
      [OWNER, SESSION, name, SHA, key, thumbKey],
    );
    return String(rows[0].id);
  }

  async function seedHistory(sessionId: string, content: string): Promise<void> {
    await pool.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content)
       VALUES ($1, 'human', 12, $2)`,
      [sessionId, content],
    );
  }

  async function historyOf(sessionId: string): Promise<string[]> {
    const { rows } = await pool.query(
      'SELECT content FROM custom_chat_history WHERE session_id = $1 ORDER BY id',
      [sessionId],
    );
    return rows.map((r) => String(r.content));
  }

  async function uploadIds(): Promise<string[]> {
    const { rows } = await pool.query('SELECT id FROM chat_uploads ORDER BY id');
    return rows.map((r) => String(r.id));
  }

  // Строка истории — тем же uploadHistoryLink, что пишет upload-and-chat (chat.controller.ts).
  const link = (name: string, id: string): string => uploadHistoryLink(name, `/webhook/chat-uploads/${id}`);

  it('владелец: объекты, строка, ссылка в истории → «файл удалён» на языке профиля; соседи целы', async () => {
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, profile_data) VALUES ($1, '{"language":"de"}')`,
      [OWNER],
    );
    const id = await seedUpload(NAME, 'k-1/gostinaya.jpg', 'thumbs/k-1/gostinaya.jpg.webp');
    const keepId = await seedUpload('план.pdf', 'k-2/plan.pdf', null);
    expect(markdownEscapeName(NAME)).toBe(ESCAPED);
    expect(link(NAME, id)).toContain(`[${ESCAPED}]`);
    await seedHistory(SESSION, `${link(NAME, id)}\n${link('план.pdf', keepId)}\nсделай светлее`);
    await seedHistory(SESSION, 'ответ ассистента без ссылки');
    // Та же строка в другой сессии не трогается: переписывается только сессия загрузки.
    await seedHistory('u-other_12', `${link(NAME, id)}\nчужое`);

    await service.deleteForOwner({ id, userId: OWNER });

    expect(storage.deleteConfirmed.mock.calls.map((call) => call[0])).toEqual([
      { bucket: 'linkeon-chat-uploads', key: 'thumbs/k-1/gostinaya.jpg.webp' },
      { bucket: 'linkeon-chat-uploads', key: 'k-1/gostinaya.jpg' },
    ]);
    expect(await uploadIds()).toEqual([keepId]);
    // Язык профиля дошёл: немецкая строка, а не русский фолбэк.
    expect(deletedUploadLine(NAME, 'de')).not.toBe(deletedUploadLine(NAME, 'ru'));
    expect(await historyOf(SESSION)).toEqual([
      `${deletedUploadLine(NAME, 'de')}\n${link('план.pdf', keepId)}\nсделай светлее`,
      'ответ ассистента без ссылки',
    ]);
    expect(await historyOf('u-other_12')).toEqual([`${link(NAME, id)}\nчужое`]);
  });

  it('языка в профиле нет — строка по-русски', async () => {
    const id = await seedUpload('a.jpg', 'k-3/a.jpg', null);
    await seedHistory(SESSION, `${link('a.jpg', id)}\nвопрос`);

    await service.deleteForOwner({ id, userId: OWNER });

    expect(await historyOf(SESSION)).toEqual(['📎 a.jpg — файл удалён\nвопрос']);
  });

  it('чужой userId — NotFoundException: строка, история и MinIO не тронуты', async () => {
    const id = await seedUpload('a.jpg', 'k-4/a.jpg', 'thumbs/k-4/a.jpg.webp');
    await seedHistory(SESSION, link('a.jpg', id));

    await expect(service.deleteForOwner({ id, userId: 'u-intruder' })).rejects.toBeInstanceOf(NotFoundException);

    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    expect(await uploadIds()).toEqual([id]);
    expect(await historyOf(SESSION)).toEqual([link('a.jpg', id)]);
  });

  it('сбой MinIO — ChatUploadDeleteError: строка и история целы; повтор после восстановления проходит', async () => {
    const id = await seedUpload('a.jpg', 'k-5/a.jpg', null);
    await seedHistory(SESSION, link('a.jpg', id));
    storage.deleteConfirmed.mockRejectedValueOnce(
      Object.assign(new Error('Service Unavailable'), {
        name: 'ServiceUnavailable',
        $metadata: { httpStatusCode: 503 },
      }),
    );

    await expect(service.deleteForOwner({ id, userId: OWNER })).rejects.toBeInstanceOf(ChatUploadDeleteError);
    expect(await uploadIds()).toEqual([id]);
    expect(await historyOf(SESSION)).toEqual([link('a.jpg', id)]);

    await service.deleteForOwner({ id, userId: OWNER });
    expect(await uploadIds()).toEqual([]);
    expect(await historyOf(SESSION)).toEqual(['📎 a.jpg — файл удалён']);
  });
});
