import { Pool } from 'pg';
import { relayFsKey } from '../linkeon-relay-fields';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JournalEntry, ProbeResult, revertBackfill, runBackfill, saveDryRunList } from './backfill';

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
const probe = jest.fn(async (u: string): Promise<ProbeResult> => RELAY[u.slice(u.lastIndexOf('/') + 1)] ?? 'missing');
const store = () => ({
  persist: jest.fn(async (urls: string[]) => new Map(urls.map((u) => [u, `${STORED}/${u.slice(u.lastIndexOf('/') + 1)}`]))),
});

maybe('перенос ссылок релея против живого Postgres', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  const OLD_SALT = process.env.RELAY_FS_SALT;
  const masked = (id: string, rest: string) => `${AGENT}/files/${relayFsKey(id)}${rest}`;

  /** Строка истории; владелец — первая часть session_id, как у всех писателей истории. */
  async function row(content: string, sender = 'ai', age = '2 hours', session = `${PHONE}_12`): Promise<number> {
    const r = await pool.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, created_at)
       VALUES ($1, $2, 12, $3, now() - $4::interval) RETURNING id`,
      [session, sender, content, age],
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
    probe.mockClear();
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
      // alive, gone (дважды), gone2, silent, gone в папке fs_key и old.pdf —
      // наш релей, записанный через http://: проба по каноническому адресу
      urls: 6,
      variantUrls: 1,
      alive: 1,
      missing: 4,
      unknown: 1,
      maskable: 3, // gone, gone2 и old.pdf; в папке fs_key маскировать нечего
      otherRows: 1, // /files/<номер>_ без хоста
      otherForeignSkipped: 0,
      updatedRows: 0,
      copied: 0,
      masked: 0,
      maskedOtherRows: 0,
    });
    expect(r.otherOrigins).toEqual(['(без хоста)']);
    expect(s.persist).not.toHaveBeenCalled();
    expect(await all()).toEqual(before);
  });

  it('--apply: живые — в хранилище, мёртвые — номер на солёный хэш; релей через http:// — по пробе, без хоста — по владельцу; молодые и «не ответил» не тронуты', async () => {
    const ids = await seed();
    const before = new Map((await all()).map((x) => [x.id, x.content]));
    const journal: JournalEntry[] = [];

    const r = await run(true, (e) => journal.push(e));

    expect(r).toMatchObject({ copied: 1, masked: 3, maskedOtherRows: 1, updatedRows: 4, skippedRows: 0 });
    expect(await contentOf(ids.mixed)).toBe(
      `[Скачать alive.pdf](${STORED}/alive.pdf)\n[Скачать gone.pdf](${masked(PHONE, '_12_ru/gone.pdf')})`,
    );
    expect(await contentOf(ids.uuid)).toBe(`[Скачать gone2.docx](${masked(UUID_USER, '_17_ru/sub/gone2.docx')})`);
    expect(await contentOf(ids.human)).toBe(`ссылка ${masked(PHONE, '_12_ru/gone.pdf')} не открывается`);
    // Наш релей через http:// — по пробе (нет файла → номер на хэш); адрес
    // без хоста с id владельца строки — заведомо мёртвый, номер на хэш.
    expect(await contentOf(ids.other)).toBe(
      `старый адрес http://r.linkeon.io/files/${relayFsKey(PHONE)}_12_ru/old.pdf и /files/${relayFsKey(PHONE)}_12/rel.pdf`,
    );
    for (const k of ['silent', 'noId', 'young', 'plain'] as const) {
      expect(await contentOf(ids[k])).toBe(before.get(ids[k]));
    }
    // В обработанных строках номера и uuid больше нет.
    for (const k of ['mixed', 'uuid', 'human', 'other'] as const) {
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
        {
          rowId: ids.other,
          relayUrl: `http://r.linkeon.io/files/${PHONE}_12_ru/old.pdf`,
          maskedUrl: `http://r.linkeon.io/files/${relayFsKey(PHONE)}_12_ru/old.pdf`,
        },
        { rowId: ids.other, linkFrom: `/files/${PHONE}`, linkTo: `/files/${relayFsKey(PHONE)}` },
      ]),
    );
    expect(journal).toHaveLength(6);
  });

  it('откат по журналу возвращает строки слово в слово', async () => {
    await seed();
    const before = await all();
    const journal: JournalEntry[] = [];
    await run(true, (e) => journal.push(e));

    const r = await revertBackfill({ pg: pool, entries: journal, log: () => {} });

    expect(r).toEqual({ reverted: 4, skipped: 0 });
    expect(await all()).toEqual(before);
  });

  it('повторный прогон ничего не меняет', async () => {
    await seed();
    await run(true);
    const after = await all();
    const journal: JournalEntry[] = [];

    const second = await run(true, (e) => journal.push(e));

    expect(second).toMatchObject({ updatedRows: 0, copied: 0, masked: 0, maskable: 0, otherRows: 0, maskedOtherRows: 0 });
    expect(journal).toEqual([]);
    expect(await all()).toEqual(after);
  });

  // Повторное ревью: сторонние живые адреса того же вида — метка времени в
  // имени, бакет files у хранилищ, ссылки из веб-поиска — не наши. Ссылка под
  // чужим хостом маскируется, только если id в ней — владелец строки.
  it('чужой хост: сторонний адрес с чужим id не тронут, с id владельца строки — замаскирован', async () => {
    const foreignOnly = await row(
      `[отчёт](https://example.com/files/${UUID_USER}_17_en/a.pdf) и https://cdn.example.com/files/1698765432_report.pdf`,
    );
    const owned = await row(`[файл](https://example.com/files/${UUID_USER}_17_en/b.pdf)`, 'ai', '2 hours', `${UUID_USER}_17`);
    const before = await contentOf(foreignOnly);

    const dry = await run(false);
    const r = await run(true);

    expect(dry).toMatchObject({ otherRows: 2, otherForeignSkipped: 1 });
    expect(r).toMatchObject({ maskedOtherRows: 1, updatedRows: 1 });
    expect(await contentOf(foreignOnly)).toBe(before);
    expect(await contentOf(owned)).toBe(`[файл](https://example.com/files/${relayFsKey(UUID_USER)}_17_en/b.pdf)`);
  });

  it('наш релей в другом написании (схема, регистр, порт) — проба у релея по каноническому адресу, не маска', async () => {
    const id = await row(
      `HTTP://R.LINKEON.IO:443/files/${PHONE}_12_ru/silent.pdf и https://R.linkeon.io/files/${PHONE}_12_ru/alive.pdf`,
    );

    const r = await run(true);

    expect(probe.mock.calls.map((c) => c[0]).sort()).toEqual([`${P}/alive.pdf`, `${P}/silent.pdf`]);
    expect(r).toMatchObject({ variantUrls: 2, copied: 1, masked: 0, maskedOtherRows: 0 });
    // «Не ответил» — как было; живой — в хранилище.
    expect(await contentOf(id)).toBe(`HTTP://R.LINKEON.IO:443/files/${PHONE}_12_ru/silent.pdf и ${STORED}/alive.pdf`);
  });

  it('сухой прогон: список кандидатов в маску — с хэшем вместо id, без номеров; в файл с правами 600', async () => {
    await seed();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-pg-dry-'));
    try {
      const r = await run(false);

      expect(r.maskCandidates.sort()).toEqual(
        [
          `404\t${masked(PHONE, '_12_ru/gone.pdf')}`,
          `404\t${masked(UUID_USER, '_17_ru/sub/gone2.docx')}`,
          `404\thttp://r.linkeon.io/files/${relayFsKey(PHONE)}_12_ru/old.pdf`,
          `чужой\t/files/${relayFsKey(PHONE)}_12/rel.pdf`,
        ].sort(),
      );
      const file = saveDryRunList(false, path.join(dir, 'backfill-chat-files-x.jsonl'), r.maskCandidates)!;
      const text = fs.readFileSync(file, 'utf8');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain(UUID_USER);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Пути на диске релея: до 26.10.2026 папка хода называлась ключом сессии с
  // номером, и модель повторяла пути в ответах (контролёр 02.11: 76 сообщений
  // с /tmp/agent-output/<номер>_…, последнее 12.10). Путь заведомо мёртвый —
  // номер в нём меняется на тот же солёный хэш пользователя.
  const hashed = (dir: 'output' | 'uploads', id: string) => `/tmp/agent-${dir}/${relayFsKey(id)}`;

  async function seedPaths() {
    return {
      output: await row(`Сохранил отчёт: /tmp/agent-output/${PHONE}_12_ru/report.pdf`),
      upload: await row(`прочитал /tmp/agent-uploads/${PHONE}_12_ru_scan.pdf`, 'human'),
      uuid: await row(`файл в /tmp/agent-output/${UUID_USER}_17_ru/plan.docx`),
      both: await row(`[Скачать gone.pdf](${P}/gone.pdf)\nпуть: /tmp/agent-output/${PHONE}_12_ru/gone.pdf`),
      fsKeyPath: await row(`/tmp/agent-output/${'cd'.repeat(16)}/x.pdf`),
      young: await row(`/tmp/agent-output/${PHONE}_12_ru/new.pdf`, 'ai', '5 minutes'),
    };
  }

  it('пути релея с номером: сухой прогон — отдельные счётчики, база не меняется', async () => {
    await seedPaths();
    const before = await all();

    const r = await run(false);

    // output, uuid и both; молодая не входит, в папке fs_key номера нет.
    expect(r).toMatchObject({ outputPathRows: 3, uploadPathRows: 1, maskedPathRows: 0, updatedRows: 0 });
    expect(await all()).toEqual(before);
  });

  it('пути релея с номером: --apply — номер на солёный хэш, журнал; повтор — ноль; откат — слово в слово', async () => {
    const ids = await seedPaths();
    const before = await all();
    const was = new Map(before.map((x) => [x.id, x.content]));
    const journal: JournalEntry[] = [];

    const r = await run(true, (e) => journal.push(e));

    expect(r).toMatchObject({ maskedPathRows: 4, updatedRows: 4, skippedRows: 0 });
    expect(await contentOf(ids.output)).toBe(`Сохранил отчёт: ${hashed('output', PHONE)}_12_ru/report.pdf`);
    expect(await contentOf(ids.upload)).toBe(`прочитал ${hashed('uploads', PHONE)}_12_ru_scan.pdf`);
    expect(await contentOf(ids.uuid)).toBe(`файл в ${hashed('output', UUID_USER)}_17_ru/plan.docx`);
    // Мёртвая ссылка и путь в одной строке — одной заменой.
    expect(await contentOf(ids.both)).toBe(
      `[Скачать gone.pdf](${masked(PHONE, '_12_ru/gone.pdf')})\nпуть: ${hashed('output', PHONE)}_12_ru/gone.pdf`,
    );
    expect(await contentOf(ids.fsKeyPath)).toBe(was.get(ids.fsKeyPath));
    expect(await contentOf(ids.young)).toBe(was.get(ids.young));
    for (const k of ['output', 'upload', 'uuid', 'both'] as const) {
      const c = await contentOf(ids[k]);
      expect(c).not.toContain(PHONE);
      expect(c).not.toContain(UUID_USER);
    }
    expect(journal).toEqual(
      expect.arrayContaining([
        { rowId: ids.output, pathFrom: `/tmp/agent-output/${PHONE}`, pathTo: hashed('output', PHONE) },
        { rowId: ids.upload, pathFrom: `/tmp/agent-uploads/${PHONE}`, pathTo: hashed('uploads', PHONE) },
        { rowId: ids.uuid, pathFrom: `/tmp/agent-output/${UUID_USER}`, pathTo: hashed('output', UUID_USER) },
        { rowId: ids.both, relayUrl: `${P}/gone.pdf`, maskedUrl: masked(PHONE, '_12_ru/gone.pdf') },
        { rowId: ids.both, pathFrom: `/tmp/agent-output/${PHONE}`, pathTo: hashed('output', PHONE) },
      ]),
    );
    expect(journal).toHaveLength(5);

    const second = await run(true);
    expect(second).toMatchObject({ outputPathRows: 0, uploadPathRows: 0, maskedPathRows: 0, updatedRows: 0 });

    const back = await revertBackfill({ pg: pool, entries: journal, log: () => {} });
    expect(back).toEqual({ reverted: 4, skipped: 0 });
    expect(await all()).toEqual(before);
  });
});
