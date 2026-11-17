import * as fs from 'fs';
import * as path from 'path';
import { Pool, QueryResult } from 'pg';

/**
 * Разовый перенос старых листов «Чистого листа» в основные ленты
 * (scripts/oneoff/2026-11-17-merge-fresh-sessions.sql, spec 2026-11-17-context-reset).
 * Скрипт исполняется целиком, как его выполнит psql на проде.
 */
const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
// Своя схема на процесс: chat_uploads / action_plans в public заводят и
// чистят другие pg-спеки — общие с ними таблицы гонялись бы.
const SCHEMA = `merge_fresh_spec_${process.pid}`;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = 'scripts/oneoff/2026-11-17-merge-fresh-sessions.sql';
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
    // У истории своей миграции в модуле нет — колонки, проверки и индекс
    // дословно из src/base/migrations/001_core_schema.sql (created_at там
    // допускает NULL).
    await pool.query(`
      CREATE TABLE custom_chat_history (
        id serial PRIMARY KEY,
        session_id text NOT NULL,
        sender_type character varying(10) NOT NULL CHECK (sender_type IN ('ai', 'human')),
        agent integer,
        content text NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
        message_type character varying(20) DEFAULT 'text' NOT NULL,
        tokens_used integer DEFAULT 0
      );
      CREATE INDEX idx_custom_chat_session ON custom_chat_history (session_id, created_at);
    `);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE custom_chat_history, chat_uploads, action_plans, chat_context_resets RESTART IDENTITY');
    now = (await pool.query('SELECT now() AS t')).rows[0].t.getTime();
  });

  /** Момент h часов назад (ISO) и метка листа, нажатого h часов назад (мс). */
  const hoursAgo = (h: number): string => new Date(now - h * HOUR).toISOString();
  const mark = (h: number): number => now - h * HOUR;
  /** Ключ листа, нажатого h часов назад. */
  const sheet = (base: string, h: number): string => `${base}_fresh_${mark(h)}`;

  /** Скрипт целиком; pg отдаёт массив результатов по выражению. */
  async function runScript(): Promise<QueryResult[]> {
    const res: QueryResult | QueryResult[] = await pool.query(read(SCRIPT));
    return Array.isArray(res) ? res : [res];
  }

  /** Счётчики, которые скрипт печатает до и после (строки со столбцом «этап»). */
  function counters(results: QueryResult[]): Record<string, unknown>[] {
    return results
      .filter((r) => r.command === 'SELECT' && r.fields.some((f) => f.name === 'этап'))
      .map((r) => r.rows[0]);
  }
  const numbers = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k === 'этап' ? v : Number(v)]));

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
  async function snapshot(): Promise<unknown> {
    const h = await pool.query('SELECT id, session_id FROM custom_chat_history ORDER BY id');
    const u = await pool.query('SELECT id, session_id FROM chat_uploads ORDER BY id');
    const p = await pool.query('SELECT id, session_id, updated_at FROM action_plans ORDER BY id');
    return { h: h.rows, u: u.rows, p: p.rows, r: await points() };
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

  it('«в режиме» решает ход человека: ответ без вопроса в основной ленте (рутина, админ) точку не отменяет', async () => {
    await turn('79000000001_10', hoursAgo(72));
    await turn(sheet('79000000001_10', 2), hoursAgo(1));
    // Утренняя рутина пишет в основную ленту и тогда, когда человек в листе.
    await say('79000000001_10', hoursAgo(0.5), 'ai');
    await runScript();
    expect(await points()).toEqual([{ user_id: '79000000001', assistant_id: '10', at: exact(mark(2)) }]);
    expect(await feeds()).toEqual({ '79000000001_10': 5 });
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

  it('повторный запуск ничего не меняет', async () => {
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

    await runScript();
    const once = await snapshot();
    await runScript();
    expect(await snapshot()).toEqual(once);
    expect(await points()).toHaveLength(1);
    expect((await feeds())['79000000001_10']).toBe(6);
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
    await upload('79000000001', sheet('79000000001_10', 2));
    await plan('79000000001', sheet('79000000001_10', 100), hoursAgo(99));
    await plan('79000000001', sheet('79000000001_10', 2), hoursAgo(0.9));
    await turn(sheet(`${TEST_ACCOUNT}_12`, 2), hoursAgo(1));

    const results = await runScript();
    const [before, after, ...rest] = counters(results);
    expect(rest).toEqual([]);
    expect(numbers(before)).toEqual({
      'этап': 'до',
      'сообщений в листах': 6,
      'загрузок в листах': 1,
      'планов в листах': 2,
      'прочих сообщений _fresh_ (не трогаем)': 2,
      'точек': 0,
    });
    expect(numbers(after)).toEqual({
      'этап': 'после',
      'сообщений в листах': 0,
      'загрузок в листах': 0,
      'планов в листах': 1,
      'прочих сообщений _fresh_ (не трогаем)': 2,
      'точек': 1,
    });
    const summary = results.filter((r) => r.fields.some((f) => f.name === 'точек по свежим листам'));
    expect(summary).toHaveLength(1);
    expect(numbers(summary[0].rows[0])).toEqual({
      'точек по свежим листам': 1,
      'давних листов без точки': 1,
      'свежих листов с неверной меткой': 1,
    });
  });
});
