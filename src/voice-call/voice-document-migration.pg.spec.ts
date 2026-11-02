import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { relayFsKey } from '../chat/linkeon-relay-fields';
import {
  DOC_PLACES,
  DocJournalEntry,
  deleteOldDocuments,
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
 * --apply копирует и меняет адреса, старые объекты не трогает; удаляет их
 * отдельный --delete-old по журналу (ревью ветки, I2), когда решит владелец.
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
const DOC_STRAY = '0e0e0e0e-5555-4555-8555-555555555555'; // старый объект без ссылок и без журнала

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
    drop: (key: string) => objects.delete(`${BUCKET}/${key}`),
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

  /** pg с журналом UPDATE — чтобы видеть, что и когда меняется. */
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

  const chat = (session: string, content: string, age = '2 hours') =>
    pool.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, created_at)
       VALUES ($1, 'ai', 12, $2, now() - $3::interval) RETURNING id`,
      [session, content, age],
    );

  async function seed(store: ReturnType<typeof memStore>) {
    store.put(oldKey(PHONE, DOC_A), '# План\n\nтекст А');
    store.put(oldKey(UUID_USER, DOC_B), '# Письмо\n\nтекст Б');
    store.put(`documents/${relayFsKey(PHONE)}/${DOC_NEW}.md`, '# Новый\n\nтекст');
    store.put(oldKey(PHONE, DOC_STRAY), '# Ничей\n\nтекст');
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

  const apply = (events: string[], store: ReturnType<typeof memStore>, journal: DocJournalEntry[] = []) =>
    runDocumentMigration({ pg: pgOf(events), store, apply: true, journal: (e) => journal.push(e), log: () => {} });

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
    if (OLD_JWT === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_JWT;
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

    expect(r).toMatchObject({ docs: 3, present: 2, alreadyCopied: 0, missing: 1, copied: 0, updatedRows: 0, readyToDelete: 0 });
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

  it('--apply: копия под новым ключом, адреса заменены во всех местах; старые объекты НЕ удаляются', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    const journal: DocJournalEntry[] = [];

    const r = await apply(events, store, journal);

    expect(r).toMatchObject({
      docs: 3, copied: 2, missing: 1, copyFailed: 0, updatedRows: 9, skippedRows: 0, readyToDelete: 2, stillReferenced: 0,
    });
    // Новые — с тем же телом; старые — на месте до --delete-old; мёртвой ссылке объекта не создано.
    expect(store.body(newKey(PHONE, DOC_A))).toBe('# План\n\nтекст А');
    expect(store.body(newKey(UUID_USER, DOC_B))).toBe('# Письмо\n\nтекст Б');
    expect(store.has(oldKey(PHONE, DOC_A))).toBe(true);
    expect(store.has(oldKey(UUID_USER, DOC_B))).toBe(true);
    expect(store.has(newKey(PHONE, DOC_GONE))).toBe(false);
    expect(events.filter((e) => e.startsWith('delete'))).toEqual([]);

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

    // Журнал: копии, замены, «можно удалять» — только места и ключи, без текстов.
    expect(journal.filter((e) => e.kind === 'row')).toHaveLength(9);
    expect(journal.filter((e) => e.kind === 'copied')).toHaveLength(2);
    expect(journal.filter((e) => e.kind === 'replaced')).toEqual([
      { kind: 'replaced', from: oldKey(PHONE, DOC_A), to: newKey(PHONE, DOC_A) },
      { kind: 'replaced', from: oldKey(UUID_USER, DOC_B), to: newKey(UUID_USER, DOC_B) },
    ]);
    expect(journal.filter((e) => e.kind === 'deleted')).toEqual([]);
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

  it('--delete-old удаляет ровно записанные в журнале; повторный — ничего', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    const journal: DocJournalEntry[] = [];
    await apply(events, store, journal);
    events.length = 0;
    const deletions: DocJournalEntry[] = [];

    const r = await deleteOldDocuments({
      pg: pgOf(events), store, entries: journal, journal: (e) => deletions.push(e), log: () => {},
    });

    expect(r).toEqual({ deleted: 2, alreadyGone: 0, kept: 0 });
    expect(store.has(oldKey(PHONE, DOC_A))).toBe(false);
    expect(store.has(oldKey(UUID_USER, DOC_B))).toBe(false);
    expect(store.has(newKey(PHONE, DOC_A))).toBe(true);
    expect(store.has(newKey(UUID_USER, DOC_B))).toBe(true);
    // Объект без записи в журнале не трогается, даже если он прежнего вида.
    expect(store.has(oldKey(PHONE, DOC_STRAY))).toBe(true);
    expect(deletions).toEqual([
      { kind: 'deleted', from: oldKey(PHONE, DOC_A), to: newKey(PHONE, DOC_A) },
      { kind: 'deleted', from: oldKey(UUID_USER, DOC_B), to: newKey(UUID_USER, DOC_B) },
    ]);
    expect(events.filter((e) => e.startsWith('update'))).toEqual([]);

    events.length = 0;
    const again: DocJournalEntry[] = [];
    const second = await deleteOldDocuments({
      pg: pgOf(events), store, entries: journal, journal: (e) => again.push(e), log: () => {},
    });

    expect(second).toEqual({ deleted: 0, alreadyGone: 2, kept: 0 });
    expect(again).toEqual([]);
    expect(events).toEqual([]);
  });

  it('--delete-old не удаляет, если на старый ключ снова есть ссылка или новой копии нет', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    const journal: DocJournalEntry[] = [];
    await apply(events, store, journal);
    // Ссылка на старый адрес A появилась снова (например, свежая строка), а
    // новой копии B в хранилище нет.
    await chat(`${PHONE}_12`, `повтор: ${urlOf(oldKey(PHONE, DOC_A))}`, '1 minute');
    store.drop(newKey(UUID_USER, DOC_B));

    const r = await deleteOldDocuments({ pg: pgOf(events), store, entries: journal, journal: () => {}, log: () => {} });

    expect(r).toEqual({ deleted: 0, alreadyGone: 0, kept: 2 });
    expect(store.has(oldKey(PHONE, DOC_A))).toBe(true);
    expect(store.has(oldKey(UUID_USER, DOC_B))).toBe(true);
  });

  // Повторное ревью: кандидаты — и из «copied», не только из «replaced»:
  // документ, скопированный при пропущенной строке, доводит следующий
  // --apply, и удалить его старый объект можно по первому журналу. Проверки
  // перед удалением те же.
  it('--delete-old берёт кандидатов и из «copied»: после доводки — удаляет по первому журналу', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    let touched = false;
    const racing = pgOf(events, async (sql, params) => {
      if (!touched && /UPDATE custom_chat_history/.test(sql)) {
        touched = true;
        await pool.query(`UPDATE custom_chat_history SET content = content || ' (правка)' WHERE id = $1`, [params[1]]);
      }
    });
    const first: DocJournalEntry[] = [];
    await runDocumentMigration({ pg: racing, store, apply: true, journal: (e) => first.push(e), log: () => {} });
    expect(first.filter((e) => e.kind === 'replaced').map((e) => e.from)).toEqual([oldKey(UUID_USER, DOC_B)]);
    await apply(events, store);

    const r = await deleteOldDocuments({ pg: pgOf(events), store, entries: first, journal: () => {}, log: () => {} });

    expect(r).toEqual({ deleted: 2, alreadyGone: 0, kept: 0 });
    expect(store.has(oldKey(PHONE, DOC_A))).toBe(false);
    expect(store.has(oldKey(UUID_USER, DOC_B))).toBe(false);
  });

  it('--delete-old: кандидат из «copied», на который ещё есть ссылка, — остаётся', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    await chat(`${UUID_USER}_17`, `свежая ссылка ${urlOf(oldKey(UUID_USER, DOC_B))}`, '5 minutes');
    const journal: DocJournalEntry[] = [];
    await apply(events, store, journal);

    const r = await deleteOldDocuments({ pg: pgOf(events), store, entries: journal, journal: () => {}, log: () => {} });

    expect(r).toEqual({ deleted: 1, alreadyGone: 0, kept: 1 });
    expect(store.has(oldKey(PHONE, DOC_A))).toBe(false);
    expect(store.has(oldKey(UUID_USER, DOC_B))).toBe(true);
  });

  // Ревью ветки, m6: фронт сверяет ленту с историей посимвольно, и свежую
  // строку держит открытая вкладка — как у переноса ссылок релея.
  it('строки истории моложе часа не трогаются, и их документ не попадает в «можно удалять»', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    const young = await chat(`${UUID_USER}_17`, `свежая ссылка ${urlOf(oldKey(UUID_USER, DOC_B))}`, '5 minutes');
    const journal: DocJournalEntry[] = [];

    const r = await apply(events, store, journal);

    expect(r.rowsByPlace['custom_chat_history.content']).toBe(3);
    expect(r).toMatchObject({ readyToDelete: 1, stillReferenced: 1 });
    const kept = await pool.query(`SELECT content FROM custom_chat_history WHERE id = $1`, [young.rows[0].id]);
    expect(kept.rows[0].content).toBe(`свежая ссылка ${urlOf(oldKey(UUID_USER, DOC_B))}`);
    expect(journal.filter((e) => e.kind === 'replaced').map((e) => e.from)).toEqual([oldKey(PHONE, DOC_A)]);
  });

  it('повторный прогон ничего не делает', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    await apply(events, store);
    const after = await snapshot();
    events.length = 0;
    const journal: DocJournalEntry[] = [];

    const second = await apply(events, store, journal);

    expect(second).toMatchObject({ docs: 0, copied: 0, updatedRows: 0, readyToDelete: 0 });
    expect(journal).toEqual([]);
    expect(events).toEqual([]);
    expect(await snapshot()).toEqual(after);
  });

  it('откат по журналу --apply возвращает адреса слово в слово', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    const before = await snapshot();
    const journal: DocJournalEntry[] = [];
    await apply(events, store, journal);

    const r = await revertDocumentMigration({ pg: pgOf(events), store, entries: journal, log: () => {} });

    expect(r).toEqual({ restoredObjects: 0, revertedRows: 9, skippedRows: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('откат после --delete-old возвращает и удалённые объекты', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    const before = await snapshot();
    const journal: DocJournalEntry[] = [];
    await apply(events, store, journal);
    await deleteOldDocuments({ pg: pgOf(events), store, entries: journal, journal: (e) => journal.push(e), log: () => {} });

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

  it('строку изменили во время переноса — она пропущена, документ не в «можно удалять»; повторный прогон доводит', async () => {
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
    const firstJournal: DocJournalEntry[] = [];

    const first = await runDocumentMigration({
      pg: racing, store, apply: true, journal: (e) => firstJournal.push(e), log: () => {},
    });

    expect(first).toMatchObject({ skippedRows: 1, readyToDelete: 1, stillReferenced: 1 });
    expect(firstJournal.filter((e) => e.kind === 'replaced').map((e) => e.from)).toEqual([oldKey(UUID_USER, DOC_B)]);
    const left = (await pool.query(`SELECT content FROM custom_chat_history WHERE content LIKE $1`, [`%documents/${PHONE}/%`])).rows;
    expect(left).toHaveLength(1);
    expect(store.has(oldKey(PHONE, DOC_A))).toBe(true);

    const secondJournal: DocJournalEntry[] = [];
    const second = await apply(events, store, secondJournal);

    expect(second).toMatchObject({ skippedRows: 0, updatedRows: 1, readyToDelete: 1 });
    expect(secondJournal.filter((e) => e.kind === 'replaced').map((e) => e.from)).toEqual([oldKey(PHONE, DOC_A)]);
    const all = Object.values(await snapshot()).flat().join('\n');
    expect(all).not.toContain(`documents/${PHONE}/`);
  });

  it('только JWT_SECRET, без RELAY_FS_SALT — отказ до первой записи', async () => {
    const events: string[] = [];
    const store = memStore(events);
    await seed(store);
    delete process.env.RELAY_FS_SALT;
    process.env.JWT_SECRET = 'jwt-voice-doc-migration-spec';

    await expect(apply(events, store)).rejects.toThrow(/RELAY_FS_SALT/);
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
