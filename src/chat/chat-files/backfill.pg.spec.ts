import { Pool } from 'pg';
import { relayFsKey } from '../linkeon-relay-fields';
import { JournalEntry, ProbeResult, revertBackfill, runBackfill } from './backfill';

/**
 * Перенос ссылок релея — против живого Postgres (спека
 * 2026-11-02-pii-out-of-prompts-design.md, п. 6). Прежний прогон (08.10 и
 * 12.10.2026) менял только адреса скопированных файлов; ссылки на файлы,
 * которых на релее уже нет (релей перезагрузился 16.09), оставались с номером
 * в адресе и уходили в промпты. Теперь номер в такой ссылке меняется на
 * солёный хэш пользователя: ссылка по-прежнему мёртвая, но без номера.
 *
 * Без PROVISIONING_PG_URL набор пропускается (как остальные *.pg.spec.ts).
 */
const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `chat_files_backfill_spec_${process.pid}`;

const AGENT = 'https://r.linkeon.io';
const PHONE = '70000000000';
const UUID_USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const P = `${AGENT}/files/${PHONE}_12_ru`;
const U = `${AGENT}/files/${UUID_USER}_17_ru`;
/** Папка релея с 26.10.2026 — fs_key, идентификатора в ней нет. */
const F = `${AGENT}/files/${'cd'.repeat(16)}`;
const STORED = 'https://my.linkeon.io/smm-media/linkeon-chat-files/0f0f0f0f';

/** Ответ релея по имени файла: живой, нет файла, не ответил. */
const RELAY: Record<string, ProbeResult> = {
  'alive.pdf': 'alive',
  'gone.pdf': 'missing',
  'gone2.docx': 'missing',
  'fresh.pdf': 'missing',
  'silent.pdf': 'unknown',
};
const probe = async (u: string): Promise<ProbeResult> => RELAY[u.slice(u.lastIndexOf('/') + 1)] ?? 'missing';
const store = () => ({
  persist: jest.fn(async (urls: string[]) => new Map(urls.map((u) => [u, `${STORED}/${u.slice(u.lastIndexOf('/') + 1)}`]))),
});

maybe('перенос ссылок релея против живого Postgres', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  const OLD_SALT = process.env.RELAY_FS_SALT;
  const masked = (id: string, rest: string) => `${AGENT}/files/${relayFsKey(id)}${rest}`;

  async function row(content: string, sender = 'ai', age = '2 hours'): Promise<number> {
    const r = await pool.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, created_at)
       VALUES ($1, $2, 12, $3, now() - $4::interval) RETURNING id`,
      [`${PHONE}_12`, sender, content, age],
    );
    return r.rows[0].id;
  }
  const contentOf = async (id: number) =>
    (await pool.query(`SELECT content FROM custom_chat_history WHERE id = $1`, [id])).rows[0].content as string;
  const all = async () =>
    (await pool.query(`SELECT id, content FROM custom_chat_history ORDER BY id`)).rows as { id: number; content: string }[];

  /** Набор строк на все случаи разом. */
  async function seed() {
    return {
      mixed: await row(`[Скачать alive.pdf](${P}/alive.pdf)\n[Скачать gone.pdf](${P}/gone.pdf)`),
      uuid: await row(`[Скачать gone2.docx](${U}/sub/gone2.docx)`),
      human: await row(`ссылка ${P}/gone.pdf не открывается`, 'human'),
      silent: await row(`[Скачать silent.pdf](${P}/silent.pdf)`),
      noId: await row(`[Скачать gone.pdf](${F}/gone.pdf)`),
      young: await row(`[Скачать fresh.pdf](${P}/fresh.pdf)`, 'ai', '5 minutes'),
      other: await row(`старый адрес http://r.linkeon.io/files/${PHONE}_12_ru/old.pdf и /files/${PHONE}_12/rel.pdf`),
      plain: await row('ответ без ссылок'),
    };
  }

  beforeAll(async () => {
    process.env.RELAY_FS_SALT = 'chat-files-backfill-spec';
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    // Как в src/base/migrations/001_core_schema.sql.
    await pool.query(`CREATE TABLE custom_chat_history (
      id serial PRIMARY KEY,
      session_id text NOT NULL,
      sender_type varchar(10) NOT NULL,
      agent integer,
      content text NOT NULL,
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      message_type varchar(20) NOT NULL DEFAULT 'text',
      tokens_used integer DEFAULT 0)`);
  });
  beforeEach(async () => {
    process.env.RELAY_FS_SALT = 'chat-files-backfill-spec';
    await pool.query('TRUNCATE custom_chat_history RESTART IDENTITY');
  });
  afterAll(async () => {
    if (OLD_SALT === undefined) delete process.env.RELAY_FS_SALT; else process.env.RELAY_FS_SALT = OLD_SALT;
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  const run = (apply: boolean, journal: (e: JournalEntry) => void = () => {}, s = store()) =>
    runBackfill({ pg: pool, store: s, agentUrl: AGENT, apply, probe, fsKey: (id) => relayFsKey(id), journal, log: () => {} });

  it('сухой прогон: разбивка по причинам, база не меняется', async () => {
    await seed();
    const before = await all();
    const s = store();

    const r = await run(false, () => {}, s);

    expect(r).toMatchObject({
      rows: 5, // mixed, uuid, human, silent, noId — молодая и «другой адрес» не входят
      humanRows: 1,
      urls: 5, // alive, gone (дважды), gone2, silent, gone в папке fs_key
      alive: 1,
      missing: 3,
      unknown: 1,
      maskable: 2, // gone и gone2; в папке fs_key маскировать нечего
      otherRows: 1,
      updatedRows: 0,
      copied: 0,
      masked: 0,
    });
    expect(r.otherOrigins).toEqual(['(без хоста)', 'http://r.linkeon.io']);
    expect(s.persist).not.toHaveBeenCalled();
    expect(await all()).toEqual(before);
  });

  it('--apply: живые — в хранилище, мёртвые — номер на солёный хэш; молодые, «не ответил» и чужой адрес не тронуты', async () => {
    const ids = await seed();
    const before = new Map((await all()).map((x) => [x.id, x.content]));
    const journal: JournalEntry[] = [];

    const r = await run(true, (e) => journal.push(e));

    expect(r).toMatchObject({ copied: 1, masked: 2, updatedRows: 3, skippedRows: 0 });
    expect(await contentOf(ids.mixed)).toBe(
      `[Скачать alive.pdf](${STORED}/alive.pdf)\n[Скачать gone.pdf](${masked(PHONE, '_12_ru/gone.pdf')})`,
    );
    expect(await contentOf(ids.uuid)).toBe(`[Скачать gone2.docx](${masked(UUID_USER, '_17_ru/sub/gone2.docx')})`);
    expect(await contentOf(ids.human)).toBe(`ссылка ${masked(PHONE, '_12_ru/gone.pdf')} не открывается`);
    for (const k of ['silent', 'noId', 'young', 'other', 'plain'] as const) {
      expect(await contentOf(ids[k])).toBe(before.get(ids[k]));
    }
    // В обработанных строках номера и uuid больше нет.
    for (const k of ['mixed', 'uuid', 'human'] as const) {
      const c = await contentOf(ids[k]);
      expect(c).not.toContain(PHONE);
      expect(c).not.toContain(UUID_USER);
    }

    expect(journal).toEqual(
      expect.arrayContaining([
        { rowId: ids.mixed, relayUrl: `${P}/alive.pdf`, storedUrl: `${STORED}/alive.pdf` },
        { rowId: ids.mixed, relayUrl: `${P}/gone.pdf`, maskedUrl: masked(PHONE, '_12_ru/gone.pdf') },
        { rowId: ids.uuid, relayUrl: `${U}/sub/gone2.docx`, maskedUrl: masked(UUID_USER, '_17_ru/sub/gone2.docx') },
        { rowId: ids.human, relayUrl: `${P}/gone.pdf`, maskedUrl: masked(PHONE, '_12_ru/gone.pdf') },
      ]),
    );
    expect(journal).toHaveLength(4);
  });

  it('откат по журналу возвращает строки слово в слово', async () => {
    await seed();
    const before = await all();
    const journal: JournalEntry[] = [];
    await run(true, (e) => journal.push(e));

    const r = await revertBackfill({ pg: pool, entries: journal, log: () => {} });

    expect(r).toEqual({ reverted: 3, skipped: 0 });
    expect(await all()).toEqual(before);
  });

  it('повторный прогон ничего не меняет', async () => {
    await seed();
    await run(true);
    const after = await all();
    const journal: JournalEntry[] = [];

    const second = await run(true, (e) => journal.push(e));

    expect(second).toMatchObject({ updatedRows: 0, copied: 0, masked: 0, maskable: 0 });
    expect(journal).toEqual([]);
    expect(await all()).toEqual(after);
  });
});
