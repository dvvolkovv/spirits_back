import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { RetentionRecipientResolver } from './retention-recipient-resolver';
import { RetentionUnsubscribeService } from './retention-unsubscribe.service';
import { RetentionService } from './retention.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `retention_preview_${process.pid}`;
const EMAIL_UUID = '11111111-1111-4111-8111-111111111111';
const SUPPRESSED_UUID = '22222222-2222-4222-8222-222222222222';
const CURIOUS_UUID = '33333333-3333-4333-8333-333333333333';
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 864e5).toISOString();
const TWENTY_FIVE_HOURS_AGO = new Date(Date.now() - 25 * 36e5).toISOString();

maybe('retention preview against PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  let service: RetentionService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 3, options: `-c search_path=${SCHEMA}` });
    await pool.query(`
      CREATE TABLE custom_chat_history (session_id text, sender_type text, created_at timestamptz);
      CREATE TABLE tg_bot_configs (id bigserial PRIMARY KEY, owner_user_id text, preset_agent_id text);
      CREATE TABLE tg_bot_messages (config_id bigint, role text, created_at timestamptz);
      CREATE TABLE agents (id serial PRIMARY KEY, name text, display_name text);
      CREATE TABLE ai_profiles_consolidated (user_id text PRIMARY KEY, email text, profile_data jsonb DEFAULT '{}', isadmin boolean DEFAULT false);
      CREATE TABLE user_id (internal_id varchar PRIMARY KEY, primary_email text);
      CREATE TABLE user_identities (
        user_id text, provider text, provider_sub text, email text,
        email_verified boolean DEFAULT false, last_used_at timestamptz, created_at timestamptz DEFAULT now()
      );
      CREATE TABLE events (user_id text, name text, props jsonb, ts timestamptz DEFAULT now());
    `);
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '001_retention_email_unsubscribes.sql'), 'utf8'));

    const pg = { query: (sql: string, params?: any[]) => pool.query(sql, params) } as any;
    const language = { resolveUserLanguage: async (id: string) => id === EMAIL_UUID ? 'en' : 'ru' } as any;
    const resolver = new RetentionRecipientResolver(pg, language);
    service = new RetentionService(pg, resolver, new RetentionUnsubscribeService(pg), { send: jest.fn() } as any);

    const chat = (uid: string, at: string) => pool.query(
      `INSERT INTO custom_chat_history VALUES ($1, 'human', $2)`,
      [`${uid}_7`, at],
    );
    await chat(EMAIL_UUID, THREE_DAYS_AGO);
    await chat(SUPPRESSED_UUID, THREE_DAYS_AGO);
    await chat('70001112233', THREE_DAYS_AGO);
    await chat('70000000000', THREE_DAYS_AGO);
    await pool.query(`INSERT INTO custom_chat_history VALUES ('dozvon_7', 'human', $1)`, [THREE_DAYS_AGO]);
    await chat(CURIOUS_UUID, TWENTY_FIVE_HOURS_AGO);

    await pool.query(`INSERT INTO ai_profiles_consolidated (user_id, email, profile_data) VALUES
      ($1, 'uuid@example.com', '{"name":"Alex"}'),
      ($2, 'blocked@example.com', '{}'),
      ('70001112233', NULL, '{}'),
      ('70000000000', 'test@example.com', '{}'),
      ($3, 'curious@example.com', '{"name":"Дмитрий"}')`,
      [EMAIL_UUID, SUPPRESSED_UUID, CURIOUS_UUID]);
    await pool.query(`INSERT INTO user_identities VALUES
      ($1, 'phone', '+79009998877', NULL, false, NULL, now())`, [SUPPRESSED_UUID]);
    await pool.query(`INSERT INTO retention_email_unsubscribes (email_normalized, token, unsubscribed_at)
      VALUES ('blocked@example.com', $1, now())`, ['x'.repeat(43)]);
    await pool.query(`INSERT INTO events (user_id, name, props) VALUES ($1, 'message_sent', '{}')`, [CURIOUS_UUID]);
    await pool.query(`INSERT INTO agents (name, display_name) VALUES ('roman', 'Роман')`);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('общий сегмент выбирает email для UUID, SMS для телефона и исключает служебные/тестовые/отписанные', async () => {
    const preview = await service.buildRetentionOutreach({ minDays: 2, maxDays: 30 });
    const byId = new Map(preview.drafts.map((d) => [d.user_id, d]));
    expect(byId.get(EMAIL_UUID)).toMatchObject({ channel: 'email', email: 'uuid@example.com', language: 'en' });
    expect(byId.get(EMAIL_UUID)?.message)
      .toContain('Hello, Alex! Your last activity in Linkeon was 3 days ago.');
    expect(byId.get('70001112233')).toMatchObject({ channel: 'sms', phone: '70001112233' });
    expect(byId.has(SUPPRESSED_UUID)).toBe(false);
    expect(byId.has('70000000000')).toBe(false);
    expect(byId.has('dozvon')).toBe(false);
    expect(preview.summary.skipped_unsubscribed).toBe(1);
  });

  it('Curious сохраняет окно 24–48 часов и ограничение меньше пяти сообщений', async () => {
    const preview = await service.buildCuriousReturnOutreach();
    expect(preview.drafts).toHaveLength(1);
    expect(preview.drafts[0]).toMatchObject({ user_id: CURIOUS_UUID, channel: 'email' });
    expect(preview.drafts[0].message)
      .toContain('Здравствуйте, Дмитрий! Последняя активность в Linkeon была 25 часов назад.');
  });
});
