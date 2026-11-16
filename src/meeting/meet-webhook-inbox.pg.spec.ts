import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MeetingWebhookInboxStore, NewInboxEvent } from './meet-webhook-inbox.store';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `meet_inbox_spec_${process.pid}`;
const CALL_ID = '11111111-1111-4111-8111-111111111111';

maybe('MeetingWebhookInboxStore PostgreSQL', () => {
  jest.setTimeout(30_000);
  let admin: Pool;
  let pool: Pool;
  let store: MeetingWebhookInboxStore;

  const event = (patch: Partial<NewInboxEvent> = {}): NewInboxEvent => ({
    callId: CALL_ID,
    idempotencyKey: 'key-1',
    trigger: 'bot.state_change',
    message: { v: 1, type: 'meet_bot_state', state: 'joined', fatal: false },
    ...patch,
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 8, options: `-c search_path=${SCHEMA}` });
    await pool.query(fs.readFileSync(
      path.join(__dirname, '..', 'voice-call', 'migrations', '001_voice_calls.sql'), 'utf8',
    ));
    const pg = {
      query: (text: string, params?: any[]) => pool.query(text, params),
      getClient: () => pool.connect(),
    };
    store = new MeetingWebhookInboxStore(pg as any);
    await Promise.all([store.onModuleInit(), store.onModuleInit()]);
    await pool.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status)
       VALUES ($1, 'inbox-user', 12, 'inbox-room', 'active')`,
      [CALL_ID],
    );
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM meeting_webhook_events');
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('параллельный startup применяет миграцию один раз', async () => {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM schema_migrations WHERE filename = $1`,
      ['meeting/006_meeting_webhook_events.sql'],
    );
    expect(r.rows[0].n).toBe(1);
    expect(await store.onModuleInit()).toBeUndefined();
  });

  it('один ключ создаёт одну строку при конкурентном enqueue', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.enqueue(event())));
    expect(results.filter((x) => x === 'inserted')).toHaveLength(1);
    expect(results.filter((x) => x === 'duplicate')).toHaveLength(7);
    const r = await pool.query('SELECT count(*)::int AS n FROM meeting_webhook_events');
    expect(r.rows[0].n).toBe(1);
  });

  it('NULL keys не сливают разные повторы', async () => {
    expect(await store.enqueue(event({ idempotencyKey: null }))).toBe('inserted');
    expect(await store.enqueue(event({ idempotencyKey: null }))).toBe('inserted');
    const r = await pool.query('SELECT count(*)::int AS n FROM meeting_webhook_events');
    expect(r.rows[0].n).toBe(2);
  });

  it('ON DELETE CASCADE удаляет inbox вместе со звонком', async () => {
    const callId = randomUUID();
    await pool.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status)
       VALUES ($1, 'inbox-user', 12, $2, 'active')`,
      [callId, `room-${callId}`],
    );
    await store.enqueue(event({ callId }));
    await pool.query('DELETE FROM voice_calls WHERE id = $1', [callId]);
    const r = await pool.query('SELECT count(*)::int AS n FROM meeting_webhook_events WHERE call_id = $1', [callId]);
    expect(r.rows[0].n).toBe(0);
  });
});
