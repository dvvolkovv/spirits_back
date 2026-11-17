import { Pool, PoolClient } from 'pg';
import { ChatUploadsService } from './chat-uploads.service';

/**
 * Миграции реестра chat_uploads против живого Postgres: 001 + 002 так, как их
 * применяет ChatUploadsService.migrate() на каждом старте API.
 *
 * Своя схема на прогон (search_path — в options каждого соединения пула):
 * соседние pg-спеки (chat-upload-account-deletion, account-deletion.synthetic)
 * делят ту же одноразовую базу и TRUNCATE-ят chat_uploads в public — общая
 * таблица перемешала бы их строки с нашими.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const SCHEMA = `chat_uploads_mig_${process.pid}_${Date.now()}`;
const SHA = 'a'.repeat(64);

type Db = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

maybe('chat_uploads: миграции 001+002 против живого Postgres', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  let service: ChatUploadsService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    // lock_timeout — страховка теста: если миграция когда-нибудь потеряет и
    // проверку каталога, и свой set_config('lock_timeout'), ожидание замка
    // упадёт с 55P03 за секунды, а не повиснет до таймаута jest.
    pool = new Pool({
      connectionString: PG,
      max: 4,
      options: `-c search_path=${SCHEMA} -c lock_timeout=3s`,
    });
    service = new ChatUploadsService(
      { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) } as any,
      {} as any,
    );
    // Два старта подряд: второй идёт по уже применённой схеме.
    await service.migrate();
    await service.migrate();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE chat_uploads');
  });

  async function insertUpload(db: Db, key: string, extra: Record<string, unknown> = {}): Promise<void> {
    const columns = ['user_id', 'session_id', 'original_name', 'mime', 'size_bytes', 'sha256', 'storage_key'];
    const values: unknown[] = ['u-mig', 'u-mig_12', 'a.pdf', 'application/pdf', 10, SHA, key];
    for (const [column, value] of Object.entries(extra)) {
      columns.push(column);
      values.push(value);
    }
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(`INSERT INTO chat_uploads (${columns.join(', ')}) VALUES (${placeholders})`, values);
  }

  it('третий старт подряд тоже проходит без ошибок', async () => {
    await expect(service.migrate()).resolves.toBeUndefined();
  });

  it('002 даёт пять колонок нужных типов и два именованных CHECK', async () => {
    const { rows: columns } = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'chat_uploads'
          AND column_name = ANY($2::text[])`,
      [SCHEMA, ['source', 'thumb_key', 'note', 'note_updated_at', 'note_assistant_id']],
    );
    const byName = Object.fromEntries(columns.map((c) => [c.column_name, [c.data_type, c.is_nullable]]));
    expect(byName).toEqual({
      source: ['text', 'NO'],
      thumb_key: ['text', 'YES'],
      note: ['text', 'YES'],
      note_updated_at: ['timestamp with time zone', 'YES'],
      note_assistant_id: ['text', 'YES'],
    });

    const { rows: checks } = await pool.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'chat_uploads'::regclass
          AND conname IN ('chat_uploads_source_check', 'chat_uploads_note_len_check')`,
    );
    expect(checks.map((r) => r.conname).sort()).toEqual([
      'chat_uploads_note_len_check',
      'chat_uploads_source_check',
    ]);
  });

  it('INSERT старой формы (без source) получает web, остальные новые поля — NULL', async () => {
    await insertUpload(pool, 'k-old/a.pdf');
    const { rows } = await pool.query(
      'SELECT source, thumb_key, note, note_updated_at, note_assistant_id FROM chat_uploads',
    );
    expect(rows).toEqual([
      { source: 'web', thumb_key: null, note: null, note_updated_at: null, note_assistant_id: null },
    ]);
  });

  it('source: web/scan/telegram принимаются, x — отвергается CHECK', async () => {
    await insertUpload(pool, 'k-web/a.pdf', { source: 'web' });
    await insertUpload(pool, 'k-scan/a.pdf', { source: 'scan' });
    await insertUpload(pool, 'k-tg/a.pdf', { source: 'telegram' });
    await expect(insertUpload(pool, 'k-x/a.pdf', { source: 'x' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'chat_uploads_source_check',
    });
  });

  it('note: 500 символов принимается, 501 — нет (символы, а не байты)', async () => {
    // Кириллица — 2 байта на символ: 500 «я» = 1000 байт и обязаны пройти.
    await insertUpload(pool, 'k-500/a.pdf', { note: 'я'.repeat(500) });
    await expect(insertUpload(pool, 'k-501/a.pdf', { note: 'я'.repeat(501) })).rejects.toMatchObject({
      code: '23514',
      constraint: 'chat_uploads_note_len_check',
    });
  });

  it('recentForSession читает новые поля с живой схемы (COLUMNS валиден)', async () => {
    await insertUpload(pool, 'k-live/a.png', {
      source: 'scan',
      thumb_key: 'thumbs/k-live/a.png.webp',
      note: 'Фото гостиной',
      note_updated_at: new Date('2026-11-16T10:00:00.000Z'),
      note_assistant_id: '7',
    });
    const [record] = await service.recentForSession('u-mig', 'u-mig_12');
    expect(record).toMatchObject({
      source: 'scan',
      thumbKey: 'thumbs/k-live/a.png.webp',
      note: 'Фото гостиной',
      noteUpdatedAt: '2026-11-16T10:00:00.000Z',
      noteAssistantId: '7',
    });
  });

  it('повторный старт не ждёт открытую пишущую транзакцию в chat_uploads', async () => {
    const writer: PoolClient = await pool.connect();
    try {
      await writer.query('BEGIN');
      await insertUpload(writer, 'k-open/a.pdf');

      // Контроль, что тест не пустой: голый ALTER TABLE … ADD COLUMN IF NOT
      // EXISTS при открытой записи ждёт ACCESS EXCLUSIVE ещё до проверки
      // колонки и падает по lock_timeout.
      await expect(
        pool.query(`DO $$
          BEGIN
            PERFORM set_config('lock_timeout', '200ms', true);
            ALTER TABLE chat_uploads ADD COLUMN IF NOT EXISTS source text;
          END $$`),
      ).rejects.toMatchObject({ code: '55P03' });

      // Настоящий путь рестарта (001 + 002): проверки каталога замка на
      // таблицу не берут, и старт проходит, не дожидаясь записи.
      const started = Date.now();
      await service.migrate();
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });
});
