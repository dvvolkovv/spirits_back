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
const TS_A = 1794804919138; // 2026-11-16T04:55:19.138Z
const TS_B = 1794468117918; // 2026-11-12T07:21:57.918Z
const CUSTOM = 'custom:0b5c9a8e-4c1d-4f7a-9e2b-5d6c7e8f9a0b';
const UUID_USER = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

/** Точка в UTC до микросекунд — так видно, что метка легла ровно, без округления. */
const exact = (ms: number): string => new Date(ms).toISOString().replace('Z', '000');

maybe('разовый перенос старых листов (pg)', () => {
  let admin: Pool;
  let pool: Pool;
  let uploads = 0;

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
  });

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
    // A: основная 10.11, лист 16.11 — на момент выката «в режиме».
    await turn('79000000001_10', '2026-11-10T10:00:00Z');
    await turn(`79000000001_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    // B: лист 12.11, потом писал в основную 17.11 — из листа вышел.
    await turn(`79000000002_10_fresh_${TS_B}`, '2026-11-12T07:30:00Z');
    await turn('79000000002_10', '2026-11-17T05:00:00Z');
    // Тестовые аккаунты — списком и по шаблону — не трогаем.
    await turn(`${TEST_ACCOUNT}_12_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    await turn(`${PATTERN_ACCOUNT}_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');

    await runScript();

    expect(await feeds()).toEqual({
      [`${TEST_ACCOUNT}_12_fresh_${TS_A}`]: 2,
      '79000000001_10': 4,
      '79000000002_10': 4,
      [`${PATTERN_ACCOUNT}_10_fresh_${TS_A}`]: 2,
    });
    expect(await points()).toEqual([{ user_id: '79000000001', assistant_id: '10', at: exact(TS_A) }]);
  });

  it('точка — ровно метка листа в мс, без округления через double', async () => {
    const odd = TS_A - 137; // …19.001
    const late = TS_A + 861; // …19.999
    await turn(`79000000001_10_fresh_${odd}`, '2026-11-16T05:00:00Z');
    await turn(`79000000002_10_fresh_${late}`, '2026-11-16T05:00:00Z');
    await runScript();
    expect(await points()).toEqual([
      { user_id: '79000000001', assistant_id: '10', at: exact(odd) },
      { user_id: '79000000002', assistant_id: '10', at: exact(late) },
    ]);
    const { rows } = await pool.query(`SELECT reset_at FROM chat_context_resets ORDER BY user_id`);
    expect(rows.map((r) => new Date(r.reset_at).getTime())).toEqual([odd, late]);
  });

  it('«в режиме» решает ход человека: ответ без вопроса в основной ленте (рутина, админ) точку не отменяет', async () => {
    await turn('79000000001_10', '2026-11-10T10:00:00Z');
    await turn(`79000000001_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    // Утренняя рутина пишет в основную ленту и тогда, когда человек в листе.
    await say('79000000001_10', '2026-11-17T06:00:00Z', 'ai');
    await runScript();
    expect(await points()).toEqual([{ user_id: '79000000001', assistant_id: '10', at: exact(TS_A) }]);
    expect(await feeds()).toEqual({ '79000000001_10': 5 });
  });

  it('повторный запуск ничего не меняет', async () => {
    await turn('79000000001_10', '2026-11-10T10:00:00Z');
    await turn(`79000000001_10_fresh_${TS_B}`, '2026-11-12T07:30:00Z');
    await turn(`79000000001_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    await turn(`79000000002_10_fresh_${TS_B}`, '2026-11-12T07:30:00Z');
    await turn('79000000002_10', '2026-11-17T05:00:00Z');
    await upload('79000000001', `79000000001_10_fresh_${TS_A}`);
    await plan('79000000001', `79000000001_10_fresh_${TS_B}`, '2026-11-12T08:00:00Z');
    await plan('79000000001', `79000000001_10_fresh_${TS_A}`, '2026-11-16T06:00:00Z');
    await turn(`${TEST_ACCOUNT}_12_fresh_${TS_A}`, '2026-11-16T05:00:00Z');

    await runScript();
    const once = await snapshot();
    await runScript();
    expect(await snapshot()).toEqual(once);
    expect(await points()).toHaveLength(1);
    expect((await feeds())['79000000001_10']).toBe(6);
  });

  it('загрузки листа переезжают в основную ленту; у тестового аккаунта остаются в листе', async () => {
    await turn(`79000000001_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    await upload('79000000001', `79000000001_10_fresh_${TS_A}`);
    await upload('79000000001', `79000000001_10_fresh_${TS_B}`);
    await upload('79000000001', '79000000001_10');
    await upload(TEST_ACCOUNT, `${TEST_ACCOUNT}_12_fresh_${TS_A}`);
    await runScript();
    const { rows } = await pool.query(`SELECT session_id FROM chat_uploads ORDER BY storage_key`);
    expect(rows.map((r) => r.session_id)).toEqual([
      '79000000001_10',
      '79000000001_10',
      '79000000001_10',
      `${TEST_ACCOUNT}_12_fresh_${TS_A}`,
    ]);
  });

  it('план: у пары нет основного — переезжает самый свежий план листа, остальные остаются; скрипт не падает', async () => {
    await turn(`79000000001_10_fresh_${TS_B}`, '2026-11-12T07:30:00Z');
    await turn(`79000000001_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    // Свежее по updated_at — старый лист: план обновляли позже.
    await plan('79000000001', `79000000001_10_fresh_${TS_B}`, '2026-11-16T09:00:00Z', 'старый лист');
    await plan('79000000001', `79000000001_10_fresh_${TS_A}`, '2026-11-16T06:00:00Z', 'новый лист');
    await runScript();
    const plans = await pool.query(`SELECT session_id, title FROM action_plans ORDER BY session_id`);
    expect(plans.rows).toEqual([
      { session_id: '79000000001_10', title: 'старый лист' },
      { session_id: `79000000001_10_fresh_${TS_A}`, title: 'новый лист' },
    ]);
    // История при этом перенесена — транзакция не откатилась.
    expect(await feeds()).toEqual({ '79000000001_10': 4 });
    expect(await points()).toHaveLength(1);
  });

  it('план: у пары есть основной — он остаётся, план листа не переезжает', async () => {
    await turn(`79000000001_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    await plan('79000000001', '79000000001_10', '2026-11-10T10:00:00Z', 'основной');
    await plan('79000000001', `79000000001_10_fresh_${TS_A}`, '2026-11-16T06:00:00Z', 'лист');
    await runScript();
    const plans = await pool.query(`SELECT session_id, title FROM action_plans ORDER BY session_id`);
    expect(plans.rows).toEqual([
      { session_id: '79000000001_10', title: 'основной' },
      { session_id: `79000000001_10_fresh_${TS_A}`, title: 'лист' },
    ]);
    expect(await feeds()).toEqual({ '79000000001_10': 2 });
  });

  it('пары одного пользователя с разными ассистентами независимы (UUID-пользователь, custom-ассистент)', async () => {
    // 10: последний ход в листе — точка.
    await turn(`${UUID_USER}_10`, '2026-11-10T10:00:00Z');
    await turn(`${UUID_USER}_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    // custom: из листа вышел — точки нет.
    await turn(`${UUID_USER}_${CUSTOM}_fresh_${TS_B}`, '2026-11-12T07:30:00Z');
    await turn(`${UUID_USER}_${CUSTOM}`, '2026-11-17T05:00:00Z');
    // 12: листа не было — ничего не меняется (хотя ход позже всех).
    await turn(`${UUID_USER}_12`, '2026-11-17T09:00:00Z');
    await runScript();
    expect(await feeds()).toEqual({
      [`${UUID_USER}_10`]: 4,
      [`${UUID_USER}_12`]: 2,
      [`${UUID_USER}_${CUSTOM}`]: 4,
    });
    expect(await points()).toEqual([{ user_id: UUID_USER, assistant_id: '10', at: exact(TS_A) }]);
  });

  it('точку новее метки листа сохраняет (GREATEST), старую — сдвигает на метку', async () => {
    await turn(`79000000001_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    await turn(`79000000002_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    // 1 — точку уже поставила после выката старая вкладка или кнопка.
    await setPoint('79000000001', '10', '2026-11-17T08:00:00.123456Z');
    // 2 — точка из давнего прошлого.
    await setPoint('79000000002', '10', '2026-11-01T00:00:00Z');
    await runScript();
    expect(await points()).toEqual([
      { user_id: '79000000001', assistant_id: '10', at: '2026-11-17T08:00:00.123456' },
      { user_id: '79000000002', assistant_id: '10', at: exact(TS_A) },
    ]);
  });

  it('неправдоподобная метка листа — ленту переносим, точку не ставим', async () => {
    const future = Date.now() + 24 * 3600 * 1000; // точка из будущего стёрла бы память навсегда
    await turn(`79000000001_10_fresh_${future}`, '2026-11-16T05:00:00Z');
    await turn('79000000002_10_fresh_100000', '2026-11-16T05:00:00Z'); // 1970
    await turn('79000000003_10_fresh_99999999999999999999999', '2026-11-16T05:00:00Z'); // не влезает в bigint
    await runScript();
    expect(await feeds()).toEqual({ '79000000001_10': 2, '79000000002_10': 2, '79000000003_10': 2 });
    expect(await points()).toEqual([]);
  });

  it('ключ нестандартного вида не трогает', async () => {
    const odd = ['79000000001_fresh_' + TS_A, `79000000001_abc_10_fresh_${TS_A}`, `79000000001_Custom:x_fresh_${TS_A}`];
    for (const s of odd) await turn(s, '2026-11-16T05:00:00Z');
    await runScript();
    expect(Object.keys(await feeds()).sort()).toEqual([...odd].sort());
    expect(await points()).toEqual([]);
  });

  it('печатает счётчики до и после с понятными подписями', async () => {
    await turn(`79000000001_10_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    await upload('79000000001', `79000000001_10_fresh_${TS_A}`);
    await plan('79000000001', `79000000001_10_fresh_${TS_B}`, '2026-11-12T08:00:00Z');
    await plan('79000000001', `79000000001_10_fresh_${TS_A}`, '2026-11-16T06:00:00Z');
    await turn(`${TEST_ACCOUNT}_12_fresh_${TS_A}`, '2026-11-16T05:00:00Z');
    const [before, after, ...rest] = counters(await runScript());
    expect(rest).toEqual([]);
    const n = (row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k === 'этап' ? v : Number(v)]));
    expect(n(before)).toEqual({
      'этап': 'до',
      'сообщений в листах': 2,
      'загрузок в листах': 1,
      'планов в листах': 2,
      'прочих сообщений _fresh_ (не трогаем)': 2,
      'точек': 0,
    });
    expect(n(after)).toEqual({
      'этап': 'после',
      'сообщений в листах': 0,
      'загрузок в листах': 0,
      'планов в листах': 1,
      'прочих сообщений _fresh_ (не трогаем)': 2,
      'точек': 1,
    });
  });
});
