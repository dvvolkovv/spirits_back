import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { relayFsKey } from '../chat/linkeon-relay-fields';
import {
  DOC_PLACES,
  DocJournalEntry,
  revertDocumentMigration,
  runDocumentMigration,
} from './voice-document-migration';

/**
 * Разовый перенос голосовых документов из documents/<id>/ в папку солёного
 * хэша (спека 2026-11-02-pii-out-of-prompts-design.md, п. 2) — против живого
 * Postgres. Таблицы мест — настоящими файлами миграций (voice_calls и
 * voice_call_jobs, action_plans, tasks и task_events), custom_chat_history —
 * копией из 001_core_schema.sql. Хранилище — в памяти.
 *
 * Без PROVISIONING_PG_URL набор пропускается (как остальные *.pg.spec.ts).
 */
const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `voice_doc_keys_spec_${process.pid}`;

const BUCKET = 'linkeon-assets';
const PUB = `https://my.linkeon.io/smm-media/${BUCKET}`;
const PHONE = '70000000000';
const UUID_USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const DOC_A = '0a0a0a0a-1111-4111-8111-111111111111'; // номер, файл на месте
const DOC_B = '0b0b0b0b-2222-4222-8222-222222222222'; // uuid почты, файл на месте
const DOC_GONE = '0c0c0c0c-3333-4333-8333-333333333333'; // номер, файла нет
const DOC_NEW = '0d0d0d0d-4444-4444-8444-444444444444'; // уже в новой папке

const oldKey = (folder: string, doc: string) => `documents/${folder}/${doc}.md`;
const urlOf = (key: string) => `${PUB}/${key}`;

/** Хранилище в памяти. Порядок записей — в общий журнал событий теста. */
function memStore(events: string[]) {
  const objects = new Map<string, { body: Buffer; contentType?: string }>();
  const put = (key: string, body: string) =>
    objects.set(`${BUCKET}/${key}`, { body: Buffer.from(body), contentType: 'text/plain; charset=utf-8' });
  return {
    objects,
    put,
    has: (key: string) => objects.has(`${BUCKET}/${key}`),
    body: (key: string) => objects.get(`${BUCKET}/${key}`)?.body.toString(),
    head: jest.fn(async (bucket: string, key: string) => {
      const o = objects.get(`${bucket}/${key}`);
      return o ? { size: o.body.length, contentType: o.contentType } : null;
    }),
    download: jest.fn(async (i: { bucket: string; key: string }) => {
      const o = objects.get(`${i.bucket}/${i.key}`);
      if (!o) throw new Error('NoSuchKey');
      return o.body;
    }),
    upload: jest.fn(async (i: { bucket: string; key: string; body: Buffer; contentType?: string }) => {
      events.push(`upload ${i.key}`);
      objects.set(`${i.bucket}/${i.key}`, { body: Buffer.from(i.body), contentType: i.contentType });
      return `${PUB}/${i.key}`;
    }),
    delete: jest.fn(async (i: { bucket: string; key: string }) => {
      events.push(`delete ${i.key}`);
      objects.delete(`${i.bucket}/${i.key}`);
    }),
  };
}

maybe('перенос голосовых документов против живого Postgres', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  const OLD_SALT = process.env.RELAY_FS_SALT;
  const OLD_JWT = process.env.JWT_SECRET;

  /** pg с журналом UPDATE — чтобы видеть порядок «замена → удаление». */
  const pgOf = (events: string[], before?: (sql: string, params: any[]) => Promise<void>) => ({
    query: async (sql: string, params: any[] = []) => {
      if (/^\s*UPDATE/i.test(sql)) {
        if (before) await before(sql, params);
        events.push(`update ${sql.match(/UPDATE (\w+)/i)?.[1]}`);
      }
      return pool.query(sql, params);
    },
  });

  const newKey = (folder: string, doc: string) => `documents/${relayFsKey(folder)}/${doc}.md`;

  /** Всё, где может лежать ссылка, — одной строкой на место, для сравнения «до/после». */
  async function snapshot(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const p of DOC_PLACES) {
      const r = await pool.query(`SELECT ${p.column}::text AS v FROM ${p.table} ORDER BY id::text`);
      out[`${p.table}.${p.column}`] = r.rows.map((x) => x.v);
    }
    return out;
  }

  async function seed(store: ReturnType<typeof memStore>) {
    store.put(oldKey(PHONE, DOC_A), '# План\n\nтекст А');
    store.put(oldKey(UUID_USER, DOC_B), '# Письмо\n\nтекст Б');
    store.put(`documents/${relayFsKey(PHONE)}/${DOC_NEW}.md`, '# Новый\n\nтекст');
    const chat = (session: string, content: string) =>
      pool.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content) VALUES ($1, 'ai', 12, $2)`,
        [session, content],
      );
    await chat(`${PHONE}_12`, `## План\n\nвступление\n\n[Открыть документ полностью](${urlOf(oldKey(PHONE, DOC_A))})`);
    await chat(`${UUID_USER}_17`, `## Письмо\n\nвступление\n\n[Открыть документ полностью](${urlOf(oldKey(UUID_USER, DOC_B))})`);
    await chat(`${PHONE}_12`, `## Старое\n\n[Открыть документ полностью](${urlOf(oldKey(PHONE, DOC_GONE))})`);
    await chat(`${PHONE}_12`, `## Новый\n\n[Открыть документ полностью](${urlOf(`documents/${relayFsKey(PHONE)}/${DOC_NEW}.md`)})`);
    await chat(`${PHONE}_12`, `обычный ответ без документа`);
    const call = await pool.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, transcript, summary)
       VALUES (gen_random_uuid(), $1, 12, 'room-1', 'completed', $2::jsonb, $3) RETURNING id`,
      [
        PHONE,
        JSON.stringify([
          { role: 'user', text: 'сделай документ', ts: 1 },
          { role: 'assistant', text: `[в чат] Документ «План»: ${urlOf(oldKey(PHONE, DOC_A))}`, ts: 2 },
        ]),
        `Сделали план, ссылка: ${urlOf(oldKey(PHONE, DOC_A))}`,
      ],
    );
    await pool.query(
      `INSERT INTO voice_call_jobs (id, call_id, specialist_agent_id, question, status, answer)
       VALUES (gen_random_uuid(), $1, 17, 'вопрос', 'done', $2)`,
      [call.rows[0].id, `Смотрите ${urlOf(oldKey(PHONE, DOC_A))}`],
    );
    await pool.query(
      `INSERT INTO action_plans (user_id, session_id, assistant_id, title, summary, items)
       VALUES ($1, $2, '12', 'План', 'итог', $3::jsonb)`,
      [PHONE, `${PHONE}_12`, JSON.stringify([{ id: 'i1', text: `Открыть ${urlOf(oldKey(PHONE, DOC_A))}`, done: false }])],
    );
    const task = await pool.query(
      `INSERT INTO tasks (user_id, title, claudemd) VALUES ($1, 'Письмо', $2) RETURNING id`,
      [UUID_USER, `Черновик: ${urlOf(oldKey(UUID_USER, DOC_B))}`],
    );
    await pool.query(`INSERT INTO task_events (task_id, kind, content) VALUES ($1, 'note', $2)`, [
      task.rows[0].id,
      `Документ готов: ${urlOf(oldKey(UUID_USER, DOC_B))}`,
    ]);
  }

  beforeAll(async () => {
    process.env.RELAY_FS_SALT = 'voice-doc-migration-spec';
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    // custom_chat_history — как в src/base/migrations/001_core_schema.sql.
    await pool.query(`CREATE TABLE custom_chat_history (
      id serial PRIMARY KEY,
      session_id text NOT NULL,
      sender_type varchar(10) NOT NULL,
      agent integer,
      content text NOT NULL,
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      message_type varchar(20) NOT NULL DEFAULT 'text',
      tokens_used integer DEFAULT 0)`);
    for (const f of [
      ['voice-call', 'migrations', '001_voice_calls.sql'],
      ['tasks', 'migrations', '001_tasks.sql'],
      ['chat', 'action-plans', 'migrations', '001_action_plans.sql'],
    ]) {
      await pool.query(fs.readFileSync(path.join(__dirname, '..', ...f), 'utf8'));
    }
  });
  beforeEach(async () => {
    process.env.RELAY_FS_SALT = 'voice-doc-migration-spec';
    await pool.query('TRUNCATE custom_chat_history, voice_calls, voice_call_jobs, action_plans, tasks, task_events CASCADE');
  });
  afterAll(async () => {
    if (OLD_SALT === undefined) delete process.env.RELAY_FS_SALT; else process.env.RELAY_FS_SALT = OLD_SALT;
    if (OLD_JWT === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_JWT;
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('сухой прогон находит ссылки во всех местах и ничего не меняет', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    const before = await snapshot();
    const journal: DocJournalEntry[] = [];

    const r = await runDocumentMigration({
      pg: pgOf(events), store, apply: false, journal: (e) => journal.push(e), log: () => {},
    });

    expect(r).toMatchObject({ docs: 3, present: 2, alreadyCopied: 0, missing: 1, copied: 0, updatedRows: 0, deleted: 0 });
    expect(r.rowsByPlace).toEqual({
      'custom_chat_history.content': 3,
      'voice_calls.transcript': 1,
      'voice_calls.summary': 1,
      'voice_call_jobs.answer': 1,
      'action_plans.items': 1,
      'tasks.claudemd': 1,
      'task_events.content': 1,
    });
    expect(await snapshot()).toEqual(before);
    expect(events).toEqual([]);
    expect(journal).toEqual([]);
  });

  it('--apply: копия под новым ключом, адреса заменены во всех местах, старый объект удалён после замены', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    const journal: DocJournalEntry[] = [];

    const r = await runDocumentMigration({
      pg: pgOf(events), store, apply: true, journal: (e) => journal.push(e), log: () => {},
    });

    expect(r).toMatchObject({ docs: 3, copied: 2, missing: 1, copyFailed: 0, updatedRows: 9, skippedRows: 0, deleted: 2, keptOld: 0 });
    // Объекты: новые — с тем же телом, старые — удалены; мёртвой ссылке объекта не создано.
    expect(store.body(newKey(PHONE, DOC_A))).toBe('# План\n\nтекст А');
    expect(store.body(newKey(UUID_USER, DOC_B))).toBe('# Письмо\n\nтекст Б');
    expect(store.has(oldKey(PHONE, DOC_A))).toBe(false);
    expect(store.has(oldKey(UUID_USER, DOC_B))).toBe(false);
    expect(store.has(newKey(PHONE, DOC_GONE))).toBe(false);
    // Удаление — только после всех замен.
    const lastUpdate = events.map((e) => e.startsWith('update')).lastIndexOf(true);
    const firstDelete = events.findIndex((e) => e.startsWith('delete'));
    expect(firstDelete).toBeGreaterThan(lastUpdate);

    // Ни номера, ни uuid пользователя в адресах документов больше нет.
    const after = await snapshot();
    const all = Object.values(after).flat().join('\n');
    expect(all).not.toContain(`documents/${PHONE}/`);
    expect(all).not.toContain(`documents/${UUID_USER}/`);
    expect(all).toContain(urlOf(newKey(PHONE, DOC_A)));
    expect(all).toContain(urlOf(newKey(UUID_USER, DOC_B)));
    expect(all).toContain(urlOf(newKey(PHONE, DOC_GONE)));
    // Расшифровка — по-прежнему валидный JSON, заменён только адрес.
    const transcript = JSON.parse(after['voice_calls.transcript'][0]);
    expect(transcript[1].text).toBe(`[в чат] Документ «План»: ${urlOf(newKey(PHONE, DOC_A))}`);
    expect(transcript[0].text).toBe('сделай документ');
    // Новая ссылка не тронута.
    expect(after['custom_chat_history.content']).toContain(
      `## Новый\n\n[Открыть документ полностью](${urlOf(`documents/${relayFsKey(PHONE)}/${DOC_NEW}.md`)})`,
    );

    // Журнал — только ключи и места, без текстов.
    const rows = journal.filter((e) => e.kind === 'row');
    expect(rows).toHaveLength(9);
    expect(journal.filter((e) => e.kind === 'copied')).toHaveLength(2);
    expect(journal.filter((e) => e.kind === 'deleted')).toEqual([
      { kind: 'deleted', from: oldKey(PHONE, DOC_A), to: newKey(PHONE, DOC_A) },
      { kind: 'deleted', from: oldKey(UUID_USER, DOC_B), to: newKey(UUID_USER, DOC_B) },
    ]);
    for (const e of journal) {
      expect(Object.keys(e).sort()).toEqual(
        e.kind === 'row' ? ['column', 'from', 'id', 'kind', 'table', 'to'] : ['from', 'kind', 'to'],
      );
    }
    const text = JSON.stringify(journal);
    for (const words of ['Открыть документ', 'вступление', 'сделай документ', 'Черновик', 'текст А']) {
      expect(text).not.toContain(words);
    }
  });

  it('повторный прогон ничего не делает', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    const args = { pg: pgOf(events), store, apply: true, journal: () => {}, log: () => {} };
    await runDocumentMigration(args);
    const after = await snapshot();
    events.length = 0;
    const journal: DocJournalEntry[] = [];

    const second = await runDocumentMigration({ ...args, journal: (e) => journal.push(e) });

    expect(second).toMatchObject({ docs: 0, copied: 0, updatedRows: 0, deleted: 0 });
    expect(journal).toEqual([]);
    expect(events).toEqual([]);
    expect(await snapshot()).toEqual(after);
  });

  it('откат по журналу возвращает адреса и старые объекты', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    const before = await snapshot();
    const journal: DocJournalEntry[] = [];
    await runDocumentMigration({ pg: pgOf(events), store, apply: true, journal: (e) => journal.push(e), log: () => {} });

    const r = await revertDocumentMigration({ pg: pgOf(events), store, entries: journal, log: () => {} });

    expect(r).toEqual({ restoredObjects: 2, revertedRows: 9, skippedRows: 0 });
    expect(await snapshot()).toEqual(before);
    expect(store.body(oldKey(PHONE, DOC_A))).toBe('# План\n\nтекст А');
    expect(store.body(oldKey(UUID_USER, DOC_B))).toBe('# Письмо\n\nтекст Б');
  });

  it('откат не исполняет чужие места из журнала', async () => {
    const r = revertDocumentMigration({
      pg: pgOf([]),
      store: memStore([]),
      entries: [{ kind: 'row', table: 'agents; DROP TABLE x', column: 'content', id: '1', from: 'a', to: 'b' }],
      log: () => {},
    });

    await expect(r).rejects.toThrow(/не из перечня/);
  });

  it('строку изменили во время переноса — она пропущена, старый объект оставлен; повторный прогон доводит', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    let touched = false;
    const racing = pgOf(events, async (sql, params) => {
      // Первая замена в истории чата: строку успели поправить.
      if (!touched && /UPDATE custom_chat_history/.test(sql)) {
        touched = true;
        await pool.query(`UPDATE custom_chat_history SET content = content || ' (правка)' WHERE id = $1`, [params[1]]);
      }
    });

    const first = await runDocumentMigration({ pg: racing, store, apply: true, journal: () => {}, log: () => {} });

    expect(first.skippedRows).toBe(1);
    expect(first.keptOld).toBeGreaterThanOrEqual(1);
    const left = (await pool.query(`SELECT content FROM custom_chat_history WHERE content LIKE $1`, [`%documents/${PHONE}/%`])).rows;
    expect(left).toHaveLength(1);
    // Ссылка в пропущенной строке — на ещё живой объект.
    const stillOld = left[0].content.match(/documents\/[^/]+\/([0-9a-f-]{36})\.md/)[1];
    expect(store.has(oldKey(PHONE, stillOld))).toBe(true);

    const second = await runDocumentMigration({ pg: pgOf(events), store, apply: true, journal: () => {}, log: () => {} });

    expect(second.skippedRows).toBe(0);
    expect(second.updatedRows).toBe(1);
    const all = Object.values(await snapshot()).flat().join('\n');
    expect(all).not.toContain(`documents/${PHONE}/`);
    expect(store.has(oldKey(PHONE, DOC_A))).toBe(false);
  });

  it('без секретов для солёного хэша — отказ до первой записи', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    delete process.env.RELAY_FS_SALT;
    delete process.env.JWT_SECRET;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        runDocumentMigration({ pg: pgOf(events), store, apply: true, journal: () => {}, log: () => {} }),
      ).rejects.toThrow(/RELAY_FS_SALT/);
    } finally {
      warn.mockRestore();
    }
    expect(events).toEqual([]);
  });

  it('места, которого нет в базе, — пропуск с пометкой, а не падение', async () => {
    const store = memStore([]);
    await seed(store);

    const r = await runDocumentMigration({
      pg: pgOf([]), store, apply: false, journal: () => {}, log: () => {},
      places: [...DOC_PLACES, { table: 'no_such_table', column: 'content' }],
    });

    expect(r.missingPlaces).toEqual(['no_such_table.content']);
    expect(r.docs).toBe(3);
  });
});
