import { Pool } from 'pg';
import { InsightsCollectService, CUSTOM_ASSISTANT, silenceSignals } from './insights-collect.service';
import { weekOf } from './insights-week';

describe('silenceSignals', () => {
  it('серии реплик подряд и «?» в тишину', () => {
    const s = silenceSignals([
      { role: 'user', text: 'вопрос' },
      { role: 'user', text: '?' },
      { role: 'user', text: '??' },
      { role: 'assistant', text: 'ответ' },
      { role: 'user', text: 'спасибо' },
    ]);
    expect(s).toEqual({ unansweredRuns: 1, silentQuestionMarks: 2 });
  });
});

const PG = process.env.INSIGHTS_PG_URL;
const maybe = PG ? describe : describe.skip;

/**
 * Минимальные копии таблиц-источников — ровно те колонки, что читает сбор.
 * Живёт в scratch-базе insights_test на ноде; на базу приложения спека не
 * пойдёт (гард ниже).
 */
const SCHEMA = `
DROP TABLE IF EXISTS custom_chat_history, ai_profiles_consolidated, user_id, agents, tg_bot_configs,
  tg_bot_messages, tg_user_identities, support_tickets, support_messages, voice_calls, events CASCADE;
CREATE TABLE custom_chat_history (id serial PRIMARY KEY, session_id text NOT NULL, sender_type text NOT NULL,
  agent int, content text NOT NULL, created_at timestamptz NOT NULL, message_type text NOT NULL DEFAULT 'text');
CREATE TABLE ai_profiles_consolidated (user_id text PRIMARY KEY, email text, isadmin boolean DEFAULT false, profile_data jsonb DEFAULT '{}');
CREATE TABLE user_id (internal_id text PRIMARY KEY, state text);
CREATE TABLE agents (id int PRIMARY KEY, name text, display_name text);
CREATE TABLE tg_bot_configs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id text NOT NULL, tg_chat_id bigint,
  preset_agent_id text, custom_agent_id uuid, display_name text NOT NULL DEFAULT 'бот');
CREATE TABLE tg_bot_messages (id bigserial PRIMARY KEY, config_id uuid NOT NULL, tg_chat_id bigint, tg_user_id bigint,
  role text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE tg_user_identities (linkeon_user_id text PRIMARY KEY, tg_user_id bigint UNIQUE, tg_username text, tg_first_name text);
CREATE TABLE support_tickets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL);
CREATE TABLE support_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL, sender_type text NOT NULL,
  content text NOT NULL, visible_to_user boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL);
CREATE TABLE voice_calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, agent_id int, provider text NOT NULL,
  status text NOT NULL, transcript jsonb, started_at timestamptz NOT NULL);
CREATE TABLE events (id bigserial PRIMARY KEY, ts timestamptz NOT NULL, user_id text, name text NOT NULL, props jsonb NOT NULL DEFAULT '{}');
`;

maybe('сбор разговоров недели', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  let svc: InsightsCollectService;
  const week = weekOf('2026-10-19');
  const IN = '2026-10-20T10:00:00Z';
  const OUT = '2026-10-10T10:00:00Z';

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 2 });
    const app = await pool.query(`SELECT to_regclass('public.token_transactions') AS t`);
    if (app.rows[0].t) throw new Error('INSIGHTS_PG_URL указывает на базу приложения');
    await pool.query(SCHEMA);
    await pool.query(`INSERT INTO agents VALUES (12, 'Роман', ''), (21, 'Кира', 'Кира')`);
    await pool.query(`INSERT INTO ai_profiles_consolidated (user_id, email, isadmin, profile_data) VALUES
      ('79990000001', 'vova@mail.ru', false, '{"name":"Владимир"}'),
      ('79990000002', null, true, '{}'),
      ('79990000003', null, false, '{}'),
      ('79990000004', null, false, '{}')`);
    await pool.query(`INSERT INTO user_id VALUES ('79990000003', 'deleted')`);
    const chat = async (session: string, rows: Array<[string, string]>, at = IN) => {
      for (const [who, text] of rows) {
        await pool.query(`INSERT INTO custom_chat_history (session_id, sender_type, agent, content, created_at) VALUES ($1, $2, 12, $3, $4)`, [
          session,
          who,
          text,
          at,
        ]);
      }
    };
    await chat('79990000001_12', [['human', 'Я Владимир, где завести бота?'], ['ai', 'В Студии']]);
    await chat('79990000001_custom:9f1c0a55-0000-0000-0000-000000000000', [['human', 'вопрос своему'], ['ai', 'ответ']]);
    await chat('70000000000_12', [['human', 'тестовый'], ['ai', 'ответ']]);
    await chat('79990000002_12', [['human', 'админ'], ['ai', 'ответ']]);
    await chat('79990000003_12', [['human', 'удалённый'], ['ai', 'ответ']]);
    await chat('79990000004_12', [['human', 'мне плохо'], ['ai', 'Позвоните: 8-800-2000-122']]);
    await chat('79990000004_21', [['human', 'старое'], ['ai', 'ответ']], OUT);
    await pool.query(`INSERT INTO tg_user_identities VALUES ('79990000001', 5001, null, 'Вова')`);
    const cfg = async (chatId: number) =>
      (await pool.query(`INSERT INTO tg_bot_configs (owner_user_id, tg_chat_id, preset_agent_id) VALUES ('79990000001', $1, '12') RETURNING id`, [chatId]))
        .rows[0].id;
    const priv = await cfg(5001);
    const ownerGroup = await cfg(-100);
    const mixedGroup = await cfg(-200);
    const tg = async (config: string, user: number | null, role: string, text: string) =>
      pool.query(`INSERT INTO tg_bot_messages (config_id, tg_user_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)`, [config, user, role, text, IN]);
    await tg(priv, 5001, 'user', 'личный вопрос');
    await tg(priv, null, 'assistant', 'ответ');
    await tg(ownerGroup, 5001, 'user', 'вопрос в своей группе');
    await tg(ownerGroup, null, 'assistant', 'ответ');
    await tg(mixedGroup, 5001, 'user', 'вопрос владельца');
    await tg(mixedGroup, 6002, 'user', 'посторонний пишет');
    await tg(mixedGroup, 6002, 'user', 'и ещё');
    const t = (await pool.query(`INSERT INTO support_tickets (user_id) VALUES ('79990000001') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO support_messages (ticket_id, sender_type, content, created_at) VALUES ($1, 'user', 'не могу пополнить', $2), ($1, 'ai', 'помогу', $2)`, [t, IN]);
    await pool.query(`INSERT INTO voice_calls (user_id, agent_id, provider, status, transcript, started_at) VALUES
      ('79990000001', 12, 'linkeon', 'completed', '[{"role":"user","text":"голосом","ts":1},{"role":"assistant","text":"ответ","ts":2}]', $1),
      ('79990000001', 12, 'linkeon_room', 'active', '[{"role":"user","text":"на встрече чужие люди","ts":1}]', $1)`, [IN]);
    await pool.query(`INSERT INTO events (ts, user_id, name, props) VALUES
      ($1, '79990000001', 'chat_quality', '{"ok":false,"empty":true}'),
      ($1, '70000000000', 'chat_quality', '{"ok":false,"failed":true}'),
      ($1, '79990000001', 'chat_quality', '{"ok":true}')`, [IN]);
    svc = new InsightsCollectService({ query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) } as any);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('берёт живых, отсекает тестовых, админов, удалённых и прошлые недели', async () => {
    const out = await svc.collect(week);
    const keys = out.conversations.map((c) => c.key).sort();
    expect(keys.filter((k) => k.startsWith('web:'))).toEqual([
      'web:79990000001_12',
      'web:79990000001_custom:9f1c0a55-0000-0000-0000-000000000000',
    ]);
    expect(out.conversations.every((c) => c.userId === '79990000001')).toBe(true);
  });

  it('кризисный разговор не берётся, только считается', async () => {
    const out = await svc.collect(week);
    expect(out.signals.crisisConversations).toBe(1);
    expect(out.conversations.some((c) => c.userId === '79990000004')).toBe(false);
  });

  it('Telegram: личка и группа с одним владельцем — да; группа с посторонними — только сигналы', async () => {
    const out = await svc.collect(week);
    const tgTexts = out.conversations.filter((c) => c.source === 'tg').flatMap((c) => c.turns.map((t) => t.text));
    expect(tgTexts).toEqual(expect.arrayContaining(['личный вопрос', 'вопрос в своей группе']));
    expect(tgTexts).not.toContain('посторонний пишет');
    expect(out.signals.thirdPartyGroupsSkipped).toBe(1);
    expect(out.signals.unansweredRuns).toBeGreaterThanOrEqual(1);
  });

  it('свой ассистент — без имени, звонок — расшифровкой, встреча — сигналом', async () => {
    const out = await svc.collect(week);
    expect(out.conversations.find((c) => c.key.includes('custom:'))?.assistant).toBe(CUSTOM_ASSISTANT);
    expect(out.conversations.find((c) => c.source === 'call')?.assistant).toBe('Роман (звонок)');
    expect(out.conversations.flatMap((c) => c.turns.map((t) => t.text))).not.toContain('на встрече чужие люди');
    expect(out.signals).toMatchObject({ meetingsTotal: 1, meetingsFailed: 1 });
  });

  it('пустые и упавшие ответы — только живых', async () => {
    expect((await svc.collect(week)).signals.emptyOrFailedTurns).toBe(1);
  });

  it('имена для обезличивания — из профиля, Telegram и почты', async () => {
    const out = await svc.collect(week);
    expect(out.names.get('79990000001')).toEqual(expect.arrayContaining(['Владимир', 'Вова', 'vova']));
  });
});
