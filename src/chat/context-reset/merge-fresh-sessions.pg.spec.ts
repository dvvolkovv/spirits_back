import * as fs from 'fs';
import * as path from 'path';
import { Pool, QueryResult } from 'pg';
import { TEST_USERS, TEST_USER_PATTERN } from '../../common/test-users';

/**
 * Разовый перенос старых листов «Чистого листа» в основные ленты и его откат
 * (scripts/oneoff/2026-11-17-merge-fresh-sessions{,-rollback}.sql,
 * spec 2026-11-17-context-reset). Скрипты исполняются целиком, как их выполнит
 * psql на проде.
 */
const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
// Своя схема на процесс: chat_uploads / action_plans / user_id в public
// заводят и чистят другие pg-спеки — общие с ними таблицы гонялись бы.
const SCHEMA = `merge_fresh_spec_${process.pid}`;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = 'scripts/oneoff/2026-11-17-merge-fresh-sessions.sql';
const ROLLBACK = 'scripts/oneoff/2026-11-17-merge-fresh-sessions-rollback.sql';
const MAP = 'oneoff_20261117_fresh_map';
const AUDIT = 'oneoff_20261117_resets_audit';
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Настоящие миграции таблиц, которые трогает скрипт, — все по порядку. */
const MIGRATIONS = [
  'src/chat/context-reset/migrations/001_chat_context_resets.sql',
  ...fs.readdirSync(path.join(ROOT, 'src/chat/chat-uploads/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => `src/chat/chat-uploads/migrations/${f}`),
  'src/chat/action-plans/migrations/001_action_plans.sql',
];

const TEST_ACCOUNT = '70000000000';
const PATTERN_ACCOUNT = '79030012345'; // TEST_USER_PATTERN ^790300[0-9]{5}$
const CUSTOM = 'custom:0b5c9a8e-4c1d-4f7a-9e2b-5d6c7e8f9a0b';
const UUID_USER = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const HOUR = 3600 * 1000;

/** Точка в UTC до микросекунд — так видно, что метка легла ровно, без округления. */
const exact = (ms: number): string => new Date(ms).toISOString().replace('Z', '000');

describe('разовый перенос старых листов — сторож копии тестовых аккаунтов', () => {
  it('в скрипте ровно номера TEST_USERS и шаблон TEST_USER_PATTERN из common/test-users.ts', () => {
    const sql = read(SCRIPT);
    const arrays = [...sql.matchAll(/ARRAY\[([^\]]*)\]/g)].map((m) => m[1]);
    expect(arrays).toHaveLength(1);
    expect(arrays[0].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))).toEqual(TEST_USERS);
    expect([...sql.matchAll(/!~ '([^']*)'/g)].map((m) => m[1])).toEqual([TEST_USER_PATTERN]);
  });
});

maybe('разовый перенос старых листов (pg)', () => {
  let admin: Pool;
  let pool: Pool;
  let uploads = 0;
  // now() базы в мс на начало теста: все даты — от него, чтобы тест не протухал
  // (точку скрипт ставит только по листам, где ход был за последние 24 часа).
  let now = 0;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });
    for (const m of MIGRATIONS) await pool.query(read(m));
    // У истории своей миграции в модуле нет — колонки, проверки и индекс как
    // в src/base/migrations/001_core_schema.sql (created_at там допускает NULL).
    // user_id — колонки признака удаления дословно оттуда же (internal_id,
    // state): удалённому аккаунту точку не ставим.
    await pool.query(`
      CREATE TABLE custom_chat_history (
        id serial PRIMARY KEY,
        session_id text NOT NULL,
        sender_type character varying(10) NOT NULL CHECK (sender_type IN ('ai', 'human')),
        agent integer,
        content text NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
        message_type character varying(20) DEFAULT 'text' NOT NULL CHECK (message_type IN ('text', 'image')),
        tokens_used integer DEFAULT 0
      );
      CREATE INDEX idx_custom_chat_session ON custom_chat_history (session_id, created_at);
      CREATE TABLE user_id (
        state text,
        internal_id character varying NOT NULL UNIQUE
      );
    `);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    // Карту и аудит заводит сам скрипт — каждый тест начинает без них.
    await pool.query(`DROP TABLE IF EXISTS ${MAP}, ${AUDIT}`);
    await pool.query(
      'TRUNCATE custom_chat_history, chat_uploads, action_plans, chat_context_resets, user_id RESTART IDENTITY',
    );
    now = (await pool.query('SELECT now() AS t')).rows[0].t.getTime();
  });

  /** Момент h часов назад (ISO) и метка листа, нажатого h часов назад (мс). */
  const hoursAgo = (h: number): string => new Date(now - h * HOUR).toISOString();
  const mark = (h: number): number => now - h * HOUR;
  /** Ключ листа, нажатого h часов назад. */
  const sheet = (base: string, h: number): string => `${base}_fresh_${mark(h)}`;

  /** Файл целиком; pg отдаёт массив результатов по выражению. */
  async function run(rel: string, edit: (sql: string) => string = (s) => s): Promise<QueryResult[]> {
    const res: QueryResult | QueryResult[] = await pool.query(edit(read(rel)));
    return Array.isArray(res) ? res : [res];
  }
  const runScript = () => run(SCRIPT);

  /** Счётчики, которые скрипт печатает до и после (строки со столбцом «этап»). */
  function counters(results: QueryResult[]): Record<string, unknown>[] {
    return results
      .filter((r) => r.command === 'SELECT' && r.fields.some((f) => f.name === 'этап'))
      .map((r) => r.rows[0]);
  }
  /** Строка результата со столбцом name. */
  function row(results: QueryResult[], name: string): Record<string, unknown> {
    const found = results.filter((r) => r.fields.some((f) => f.name === name));
    expect(found).toHaveLength(1);
    return found[0].rows[0];
  }
  const numbers = (r: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'этап' ? v : Number(v)]));

  const say = (sessionId: string, at: string, sender: 'human' | 'ai' = 'human') =>
    pool.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, content, created_at) VALUES ($1, $2, 'x', $3)`,
      [sessionId, sender, at],
    );
  /** Ход: вопрос человека и ответ ассистента секундой позже — отдельными строками, как в чате. */
  async function turn(sessionId: string, at: string): Promise<void> {
    await say(sessionId, at, 'human');
    await say(sessionId, new Date(new Date(at).getTime() + 1000).toISOString(), 'ai');
  }
  const upload = (userId: string, sessionId: string) =>
    pool.query(
      `INSERT INTO chat_uploads (user_id, session_id, original_name, mime, size_bytes, sha256, storage_key)
       VALUES ($1, $2, 'a.pdf', 'application/pdf', 1, $3, $4)`,
      [userId, sessionId, 'a'.repeat(64), `chat-uploads/k${++uploads}`],
    );
  const plan = (userId: string, sessionId: string, updatedAt: string, title = 'план') =>
    pool.query(
      `INSERT INTO action_plans (user_id, session_id, assistant_id, title, updated_at) VALUES ($1, $2, '10', $3, $4)`,
      [userId, sessionId, title, updatedAt],
    );
  const setPoint = (userId: string, assistantId: string, at: string) =>
    pool.query(
      `INSERT INTO chat_context_resets (user_id, assistant_id, reset_at) VALUES ($1, $2, $3)`,
      [userId, assistantId, at],
    );
  const exists = async (table: string): Promise<boolean> =>
    (await pool.query('SELECT to_regclass($1) IS NOT NULL AS e', [table])).rows[0].e;

  async function feeds(): Promise<Record<string, number>> {
    const { rows } = await pool.query(
      `SELECT session_id, count(*)::int AS n FROM custom_chat_history GROUP BY 1 ORDER BY 1`,
    );
    return Object.fromEntries(rows.map((r) => [r.session_id, r.n]));
  }
  async function points(): Promise<{ user_id: string; assistant_id: string; at: string }[]> {
    const { rows } = await pool.query(
      `SELECT user_id, assistant_id,
              to_char(reset_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS at
         FROM chat_context_resets ORDER BY 1, 2`,
    );
    return rows;
  }
  /** Данные трёх таблиц и точки; с oneoff — ещё карта и аудит. */
  async function snapshot(oneoff = false): Promise<Record<string, unknown>> {
    const h = await pool.query('SELECT id, session_id, sender_type, created_at FROM custom_chat_history ORDER BY id');
    const u = await pool.query('SELECT id, user_id, session_id FROM chat_uploads ORDER BY id');
    const p = await pool.query('SELECT id, user_id, session_id, title, updated_at FROM action_plans ORDER BY id');
    const snap: Record<string, unknown> = { h: h.rows, u: u.rows, p: p.rows, r: await points() };
    if (oneoff) {
      snap.map = (await pool.query(`SELECT kind, row_id, fresh_suffix, moved_at FROM ${MAP} ORDER BY 1, 2`)).rows;
      snap.audit = (await pool.query(`SELECT * FROM ${AUDIT} ORDER BY 1, 2`)).rows;
    }
    return snap;
  }

  /** Типичная смесь: свежий лист, вышедший из листа, давний лист, загрузка, планы, тестовый аккаунт. */
  async function seedMix(): Promise<void> {
    await turn('79000000001_10', hoursAgo(72));
    await turn(sheet('79000000001_10', 100), hoursAgo(99));
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    await turn(sheet('79000000002_10', 5), hoursAgo(4));
    await turn('79000000002_10', hoursAgo(0.5));
    await turn(sheet('79000000003_10', 73), hoursAgo(72)); // давний — без точки
    await upload('79000000001', sheet('79000000001_10', 2));
    await plan('79000000001', sheet('79000000001_10', 100), hoursAgo(99));
    await plan('79000000001', sheet('79000000001_10', 2), hoursAgo(0.9));
    await turn(sheet(`${TEST_ACCOUNT}_12`, 2), hoursAgo(1));
    await upload(TEST_ACCOUNT, sheet(`${TEST_ACCOUNT}_12`, 2));
  }

  it('переносит листы в основную ленту; точку ставит тому, у кого последний ход — в листе', async () => {
    // A: основная три дня назад, лист час назад — «в режиме».
    await turn('79000000001_10', hoursAgo(72));
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    // B: лист, потом писал в основную — из листа вышел.
    await turn(sheet('79000000002_10', 5), hoursAgo(4));
    await turn('79000000002_10', hoursAgo(0.5));
    // Тестовые аккаунты — списком и по шаблону — не трогаем.
    await turn(sheet(`${TEST_ACCOUNT}_12`, 2), hoursAgo(1));
    await turn(sheet(`${PATTERN_ACCOUNT}_10`, 2), hoursAgo(1));

    await runScript();

    expect(await feeds()).toEqual({
      [sheet(`${TEST_ACCOUNT}_12`, 2)]: 2,
      '79000000001_10': 4,
      '79000000002_10': 4,
      [sheet(`${PATTERN_ACCOUNT}_10`, 2)]: 2,
    });
    expect(await points()).toEqual([{ user_id: '79000000001', assistant_id: '10', at: exact(mark(2)) }]);
  });

  it('точка — ровно метка листа в мс, без округления через double', async () => {
    const second = Math.floor(mark(2) / 1000) * 1000;
    const odd = second + 1; // …,001
    const late = second + 999; // …,999
    await turn(`79000000001_10_fresh_${odd}`, hoursAgo(1));
    await turn(`79000000002_10_fresh_${late}`, hoursAgo(1));
    await runScript();
    expect(await points()).toEqual([
      { user_id: '79000000001', assistant_id: '10', at: exact(odd) },
      { user_id: '79000000002', assistant_id: '10', at: exact(late) },
    ]);
    const { rows } = await pool.query(`SELECT reset_at FROM chat_context_resets ORDER BY user_id`);
    expect(rows.map((r) => new Date(r.reset_at).getTime())).toEqual([odd, late]);
  });

  it('часы клиента спешили (метка позже начала листа) — точка за 1 мс до первой строки листа', async () => {
    // Лист «нажат» по часам клиента час назад, а первая строка легла полтора
    // часа назад: точка по метке спрятала бы от ассистента начало листа.
    const key = sheet('79000000001_10', 1);
    await say(key, new Date(mark(1.5)).toISOString().replace('Z', '456Z'), 'human'); // с микросекундами
    await say(key, hoursAgo(1.4), 'ai');
    await runScript();
    expect(await points()).toEqual([{ user_id: '79000000001', assistant_id: '10', at: exact(mark(1.5) - 1) }]);
  });

  it('«в режиме» решает ход человека: ответ без вопроса в основной ленте (рутина, админ) точку не отменяет', async () => {
    await turn('79000000001_10', hoursAgo(72));
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    // Утренняя рутина пишет в основную ленту и тогда, когда человек в листе.
    await say('79000000001_10', hoursAgo(0.5), 'ai');
    await runScript();
    expect(await points()).toEqual([{ user_id: '79000000001', assistant_id: '10', at: exact(mark(2)) }]);
    expect(await feeds()).toEqual({ '79000000001_10': 5 });
  });

  it('несколько листов у пары: последний ход человека — в старом листе, новее лист без ходов человека — точка по старому', async () => {
    await turn(sheet('79000000001_10', 3), hoursAgo(2));
    // Новее лист, где только ответ без вопроса и загрузка.
    await say(sheet('79000000001_10', 1), hoursAgo(0.5), 'ai');
    await upload('79000000001', sheet('79000000001_10', 1));
    await runScript();
    expect(await points()).toEqual([{ user_id: '79000000001', assistant_id: '10', at: exact(mark(3)) }]);
    expect(await feeds()).toEqual({ '79000000001_10': 3 });
  });

  it('свежий лист (ход час назад) — точка; давний (ход три дня назад) — лента перенесена, точки нет', async () => {
    await turn('79000000001_10', hoursAgo(200));
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    // Вкладку с давним листом, скорее всего, закрыли — человек вернулся к
    // основной памяти; точка по такому листу стёрла бы ему её.
    await turn('79000000002_10', hoursAgo(200));
    await turn(sheet('79000000002_10', 73), hoursAgo(72));
    await runScript();
    expect(await feeds()).toEqual({ '79000000001_10': 4, '79000000002_10': 4 });
    expect(await points()).toEqual([{ user_id: '79000000001', assistant_id: '10', at: exact(mark(2)) }]);
  });

  it('граница окна — ровно 24 часа до запуска скрипта, включительно', async () => {
    // Данные и скрипт — в одной транзакции: now() у скрипта тот же, что у
    // вставок, и границу можно проверить до микросекунды. BEGIN скрипта внутри
    // открытой транзакции — лишь WARNING, его COMMIT фиксирует всё.
    const client = await pool.connect();
    let failed: Error | undefined;
    try {
      await client.query('BEGIN');
      const human = (s: string, at: string) =>
        client.query(
          `INSERT INTO custom_chat_history (session_id, sender_type, content, created_at) VALUES ($1, 'human', 'x', ${at})`,
          [s],
        );
      await human(sheet('79000000001_10', 25), `now() - interval '24 hours'`);
      await human(sheet('79000000002_10', 25), `now() - interval '24 hours' - interval '1 microsecond'`);
      await client.query(read(SCRIPT));
    } catch (e) {
      failed = e as Error;
      throw e;
    } finally {
      client.release(failed);
    }
    expect(await feeds()).toEqual({ '79000000001_10': 1, '79000000002_10': 1 });
    expect(await points()).toEqual([{ user_id: '79000000001', assistant_id: '10', at: exact(mark(25)) }]);
  });

  it('удалённому аккаунту точку не ставит (строка осталась бы сиротой), ленту переносит', async () => {
    await pool.query(`INSERT INTO user_id (internal_id, state) VALUES ('79000000001', 'deleted'), ('79000000002', 'active')`);
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    await turn(sheet('79000000002_10', 2), hoursAgo(1));
    await runScript();
    expect(await feeds()).toEqual({ '79000000001_10': 2, '79000000002_10': 2 });
    expect(await points()).toEqual([{ user_id: '79000000002', assistant_id: '10', at: exact(mark(2)) }]);
  });

  it('повторный запуск ничего не меняет — и карту с аудитом не дублирует', async () => {
    await seedMix();
    await runScript();
    const once = await snapshot(true);
    await runScript();
    expect(await snapshot(true)).toEqual(once);
    expect(await points()).toHaveLength(1);
    expect((await feeds())['79000000001_10']).toBe(6);
  });

  it('карта отката — в базе, по строке на перенос, без телефонов; аудит — по паре, где точка поставлена или сдвинута', async () => {
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    await upload('79000000001', sheet('79000000001_10', 2));
    await plan('79000000001', sheet('79000000001_10', 2), hoursAgo(0.9));
    await turn(sheet('79000000002_10', 2), hoursAgo(1));
    await setPoint('79000000002', '10', hoursAgo(240)); // старая точка — сдвигается
    await turn(sheet('79000000003_10', 2), hoursAgo(1));
    await setPoint('79000000003', '10', hoursAgo(0.5)); // новее метки — не трогаем, в аудит не идёт
    await runScript();

    const upId = (await pool.query('SELECT id FROM chat_uploads')).rows[0].id;
    const planId = (await pool.query('SELECT id FROM action_plans')).rows[0].id;
    const map = (await pool.query(`SELECT kind, row_id, fresh_suffix FROM ${MAP} ORDER BY kind, row_id`)).rows;
    const suffix = `_fresh_${mark(2)}`;
    expect(map).toEqual([
      ...['1', '2', '3', '4', '5', '6'].map((id) => ({ kind: 'h', row_id: id, fresh_suffix: suffix })),
      { kind: 'p', row_id: planId, fresh_suffix: suffix },
      { kind: 'u', row_id: upId, fresh_suffix: suffix },
    ]);
    expect(JSON.stringify(map)).not.toMatch(/7900000000/);

    const audit = await pool.query(
      `SELECT user_id, assistant_id,
              to_char(old_reset_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS old_at,
              to_char(new_reset_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS new_at
         FROM ${AUDIT} ORDER BY 1, 2`,
    );
    expect(audit.rows).toEqual([
      { user_id: '79000000001', assistant_id: '10', old_at: null, new_at: exact(mark(2)) },
      { user_id: '79000000002', assistant_id: '10', old_at: exact(mark(240)), new_at: exact(mark(2)) },
    ]);
  });

  it('откат возвращает всё как было; точку, поставленную после переноса, не трогает; повторный откат ничего не меняет', async () => {
    await seedMix();
    await turn(sheet('79000000004_10', 2), hoursAgo(1));
    await setPoint('79000000004', '10', hoursAgo(240)); // переносом сдвинется, откатом вернётся
    await turn(sheet('79000000005_10', 2), hoursAgo(1)); // человек нажмёт «Чистый лист» после переноса
    const before = await snapshot();

    await runScript();
    expect(await points()).toHaveLength(3);
    // После переноса человек 5 сам поставил точку — откат её не трогает.
    await pool.query(
      `UPDATE chat_context_resets SET reset_at = now() WHERE user_id = '79000000005' AND assistant_id = '10'`,
    );
    const later = (await points()).find((p) => p.user_id === '79000000005')!;

    const results = await run(ROLLBACK);
    const after = await snapshot();
    expect({ ...after, r: undefined }).toEqual({ ...before, r: undefined });
    expect(await points()).toEqual([
      { user_id: '79000000004', assistant_id: '10', at: exact(mark(240)) },
      later,
    ]);
    expect(numbers(row(results, 'точек возвращено'))).toEqual({
      'сообщений возвращено в листы': 12,
      'загрузок возвращено': 1,
      'планов возвращено': 1,
      'точек возвращено': 1,
      'точек удалено': 1,
      'точек не тронуто (сдвинуты позже)': 1,
    });

    await run(ROLLBACK);
    expect(await snapshot()).toEqual(after);
  });

  it('предварительный прогон (COMMIT заменён на ROLLBACK) ничего не меняет и печатает счётчики', async () => {
    await seedMix();
    const before = await snapshot();
    const sql = read(SCRIPT);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    const results = await run(SCRIPT, (s) => s.replace(/^COMMIT;$/m, 'ROLLBACK;'));
    expect(await snapshot()).toEqual(before);
    expect(await exists(MAP)).toBe(false);
    expect(await exists(AUDIT)).toBe(false);
    expect(counters(results).map((c) => c['этап'])).toEqual(['до', 'после']);
  });

  it('ошибка на позднем шаге откатывает всё: ни переноса, ни точек, ни карты', async () => {
    await seedMix();
    const before = await snapshot();
    await pool.query(`
      CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
      CREATE TRIGGER boom BEFORE UPDATE ON action_plans FOR EACH ROW EXECUTE FUNCTION boom();
    `);
    try {
      await expect(runScript()).rejects.toThrow('boom');
    } finally {
      await pool.query('DROP TRIGGER boom ON action_plans; DROP FUNCTION boom()');
    }
    expect(await snapshot()).toEqual(before);
    expect(await points()).toEqual([]);
    expect(await exists(MAP)).toBe(false);
    expect(await exists(AUDIT)).toBe(false);
  });

  it('загрузки листа переезжают в основную ленту; у тестового аккаунта остаются в листе', async () => {
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    await upload('79000000001', sheet('79000000001_10', 2));
    await upload('79000000001', sheet('79000000001_10', 100));
    await upload('79000000001', '79000000001_10');
    await upload(TEST_ACCOUNT, sheet(`${TEST_ACCOUNT}_12`, 2));
    await runScript();
    const { rows } = await pool.query(`SELECT session_id FROM chat_uploads ORDER BY storage_key`);
    expect(rows.map((r) => r.session_id)).toEqual([
      '79000000001_10',
      '79000000001_10',
      '79000000001_10',
      sheet(`${TEST_ACCOUNT}_12`, 2),
    ]);
  });

  it('план: у пары нет основного — переезжает самый свежий план листа, остальные остаются; скрипт не падает', async () => {
    await turn(sheet('79000000001_10', 100), hoursAgo(99));
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    // Свежее по updated_at — старый лист: план обновляли позже.
    await plan('79000000001', sheet('79000000001_10', 100), hoursAgo(0.5), 'старый лист');
    await plan('79000000001', sheet('79000000001_10', 2), hoursAgo(0.9), 'новый лист');
    await runScript();
    const plans = await pool.query(`SELECT session_id, title FROM action_plans ORDER BY session_id`);
    expect(plans.rows).toEqual([
      { session_id: '79000000001_10', title: 'старый лист' },
      { session_id: sheet('79000000001_10', 2), title: 'новый лист' },
    ]);
    // История при этом перенесена — транзакция не откатилась.
    expect(await feeds()).toEqual({ '79000000001_10': 4 });
    expect(await points()).toHaveLength(1);
  });

  it('план: у пары есть основной — он остаётся, план листа не переезжает', async () => {
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    await plan('79000000001', '79000000001_10', hoursAgo(72), 'основной');
    await plan('79000000001', sheet('79000000001_10', 2), hoursAgo(0.9), 'лист');
    await runScript();
    const plans = await pool.query(`SELECT session_id, title FROM action_plans ORDER BY session_id`);
    expect(plans.rows).toEqual([
      { session_id: '79000000001_10', title: 'основной' },
      { session_id: sheet('79000000001_10', 2), title: 'лист' },
    ]);
    expect(await feeds()).toEqual({ '79000000001_10': 2 });
  });

  it('пары одного пользователя с разными ассистентами независимы (UUID-пользователь, custom-ассистент)', async () => {
    // 10: последний ход в листе — точка.
    await turn(`${UUID_USER}_10`, hoursAgo(72));
    await turn(sheet(`${UUID_USER}_10`, 2), hoursAgo(1));
    // custom: из листа вышел — точки нет.
    await turn(sheet(`${UUID_USER}_${CUSTOM}`, 5), hoursAgo(4));
    await turn(`${UUID_USER}_${CUSTOM}`, hoursAgo(0.5));
    // 12: листа не было — ничего не меняется (хотя ход позже всех).
    await turn(`${UUID_USER}_12`, hoursAgo(0.25));
    await runScript();
    expect(await feeds()).toEqual({
      [`${UUID_USER}_10`]: 4,
      [`${UUID_USER}_12`]: 2,
      [`${UUID_USER}_${CUSTOM}`]: 4,
    });
    expect(await points()).toEqual([{ user_id: UUID_USER, assistant_id: '10', at: exact(mark(2)) }]);
  });

  it('точку новее метки листа сохраняет (GREATEST), старую — сдвигает на метку', async () => {
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    await turn(sheet('79000000002_10', 2), hoursAgo(1));
    // 1 — точку уже поставила после выката старая вкладка или кнопка.
    const newer = new Date(mark(0.5)).toISOString().replace('Z', '456Z');
    await setPoint('79000000001', '10', newer);
    // 2 — точка десятидневной давности.
    await setPoint('79000000002', '10', hoursAgo(240));
    await runScript();
    expect(await points()).toEqual([
      { user_id: '79000000001', assistant_id: '10', at: new Date(mark(0.5)).toISOString().replace('Z', '456') },
      { user_id: '79000000002', assistant_id: '10', at: exact(mark(2)) },
    ]);
  });

  it('неправдоподобная метка листа — ленту переносим, точку не ставим', async () => {
    const future = now + 24 * HOUR; // точка из будущего стёрла бы память навсегда
    await turn(`79000000001_10_fresh_${future}`, hoursAgo(1));
    await turn('79000000002_10_fresh_100000', hoursAgo(1)); // 1970
    await turn('79000000003_10_fresh_99999999999999999999999', hoursAgo(1)); // не влезает в bigint
    await runScript();
    expect(await feeds()).toEqual({ '79000000001_10': 2, '79000000002_10': 2, '79000000003_10': 2 });
    expect(await points()).toEqual([]);
  });

  it('ключ нестандартного вида не трогает', async () => {
    const odd = [`79000000001_fresh_${mark(2)}`, sheet('79000000001_abc_10', 2), sheet('79000000001_Custom:x', 2)];
    for (const s of odd) await turn(s, hoursAgo(1));
    await runScript();
    expect(Object.keys(await feeds()).sort()).toEqual([...odd].sort());
    expect(await points()).toEqual([]);
  });

  it('печатает счётчики до и после и итог точек с понятными подписями', async () => {
    await turn(sheet('79000000001_10', 2), hoursAgo(1)); // свежий — точка
    await turn(sheet('79000000002_10', 73), hoursAgo(72)); // давний — без точки
    await turn(`79000000003_10_fresh_${now + 24 * HOUR}`, hoursAgo(1)); // свежий, метка из будущего
    await pool.query(`INSERT INTO user_id (internal_id, state) VALUES ('79000000004', 'deleted')`);
    await turn(sheet('79000000004_10', 2), hoursAgo(1)); // свежий, аккаунт удалён
    await upload('79000000001', sheet('79000000001_10', 2));
    await plan('79000000001', sheet('79000000001_10', 100), hoursAgo(99));
    await plan('79000000001', sheet('79000000001_10', 2), hoursAgo(0.9));
    // «Прочие» — тестовый аккаунт во всех трёх таблицах.
    await turn(sheet(`${TEST_ACCOUNT}_12`, 2), hoursAgo(1));
    await upload(TEST_ACCOUNT, sheet(`${TEST_ACCOUNT}_12`, 2));
    await plan(TEST_ACCOUNT, sheet(`${TEST_ACCOUNT}_12`, 2), hoursAgo(1));

    const results = await runScript();
    const [before, after, ...rest] = counters(results);
    expect(rest).toEqual([]);
    expect(numbers(before)).toEqual({
      'этап': 'до',
      'сообщений в листах': 8,
      'загрузок в листах': 1,
      'планов в листах': 2,
      'прочих сообщений _fresh_': 2,
      'прочих загрузок _fresh_': 1,
      'прочих планов _fresh_': 1,
      'точек': 0,
      'строк в карте отката': 0,
    });
    expect(numbers(after)).toEqual({
      'этап': 'после',
      'сообщений в листах': 0,
      'загрузок в листах': 0,
      'планов в листах': 1,
      'прочих сообщений _fresh_': 2,
      'прочих загрузок _fresh_': 1,
      'прочих планов _fresh_': 1,
      'точек': 1,
      'строк в карте отката': 10,
    });
    expect(numbers(row(results, 'точек поставлено или сдвинуто'))).toEqual({
      'точек поставлено или сдвинуто': 1,
      'давних листов без точки': 1,
      'свежих листов с неверной меткой': 1,
      'удалённых аккаунтов без точки': 1,
    });
  });
});
