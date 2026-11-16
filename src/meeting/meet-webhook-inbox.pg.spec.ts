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
  let migrationBodyRuns = 0;

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
      getClient: async () => {
        const client: any = await pool.connect();
        if (!client.__counted) {
          client.__counted = true;
          const orig = client.query.bind(client);
          client.query = (text: any, ...rest: any[]) => {
            if (typeof text === 'string' && text.includes('CREATE TABLE IF NOT EXISTS meeting_webhook_events')) {
              migrationBodyRuns++;
            }
            return orig(text, ...rest);
          };
        }
        return client;
      },
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
    expect(migrationBodyRuns).toBe(1);
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM schema_migrations WHERE filename = $1`,
      ['meeting/006_meeting_webhook_events.sql'],
    );
    expect(after.rows[0].n).toBe(1);
  });

  it('есть не-partial индекс по call_id для каскада', async () => {
    const r = await pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'meeting_webhook_events_call_idx'`,
      [SCHEMA],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].indexdef).not.toMatch(/WHERE/i);
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

  it('атомарный claim исключает двойной захват и поднимает stale processing', async () => {
    await store.enqueue(event());
    const claims = await Promise.all([store.claimBatch(), store.claimBatch()]);
    expect(claims.flat()).toHaveLength(1);
    expect(claims.flat()[0].attempts).toBe(1);
    expect(await store.claimBatch()).toHaveLength(0);

    await pool.query(
      `UPDATE meeting_webhook_events SET updated_at = now() - interval '61 seconds'`,
    );
    const stale = await store.claimBatch();
    expect(stale).toHaveLength(1);
    expect(stale[0].attempts).toBe(2);
    expect(stale[0].recovered).toBe(true);
  });

  it('failure возвращает pending с задержкой, десятая попытка становится dead', async () => {
    await store.enqueue(event());
    const [claimed] = await store.claimBatch();
    const retryAt = new Date(Date.now() + 1000);
    expect(await store.markFailed(claimed.id, claimed.attempts, 'temporary', retryAt)).toBe('pending');
    const persisted = await pool.query(
      `SELECT status, next_retry_at, last_error FROM meeting_webhook_events WHERE id = $1`,
      [claimed.id],
    );
    expect(persisted.rows[0].status).toBe('pending');
    expect(persisted.rows[0].next_retry_at.toISOString()).toBe(retryAt.toISOString());
    expect(persisted.rows[0].last_error).toBe('temporary');
    expect(await store.claimBatch()).toHaveLength(0);

    await pool.query(
      `UPDATE meeting_webhook_events
          SET attempts = 9, next_retry_at = now() - interval '1 second'`,
    );
    const [last] = await store.claimBatch();
    expect(last.attempts).toBe(10);
    expect(await store.markFailed(last.id, last.attempts, 'permanent', retryAt)).toBe('dead');
    const r = await pool.query(`SELECT status, last_error FROM meeting_webhook_events`);
    expect(r.rows[0]).toEqual({ status: 'dead', last_error: 'permanent' });
  });

  it('success и inactive переводят processing в delivered/discarded', async () => {
    await store.enqueue(event({ idempotencyKey: 'deliver' }));
    await store.enqueue(event({ idempotencyKey: 'discard' }));
    const claimed = (await store.claimBatch()).sort((a, b) => Number(a.id) - Number(b.id));
    await store.markDelivered(claimed[0].id);
    await store.markDiscarded(claimed[1].id, 'call inactive');
    const r = await pool.query(
      `SELECT status, delivered_at IS NOT NULL AS has_delivery, last_error
         FROM meeting_webhook_events ORDER BY id`,
    );
    expect(r.rows[0].status).toBe('delivered');
    expect(r.rows[0].has_delivery).toBe(true);
    expect(r.rows[1]).toEqual({ status: 'discarded', has_delivery: false, last_error: 'call inactive' });
  });

  it('retention удаляет только завершённые записи нужного возраста', async () => {
    const rows: Array<[string, string, string]> = [
      ['delivered', '25 hours', 'old-delivered'],
      ['discarded', '25 hours', 'old-discarded'],
      ['dead', '8 days', 'old-dead'],
      ['pending', '25 hours', 'old-pending'],
      ['processing', '25 hours', 'old-processing'],
      ['delivered', '23 hours', 'fresh-delivered'],
      ['discarded', '23 hours', 'fresh-discarded'],
      ['dead', '6 days', 'fresh-dead'],
    ];
    for (const [status, age, key] of rows) {
      await store.enqueue(event({ idempotencyKey: key }));
      await pool.query(
        `UPDATE meeting_webhook_events
            SET status = $1, updated_at = now() - $2::interval
          WHERE idempotency_key = $3`,
        [status, age, key],
      );
    }
    expect(await store.cleanup()).toEqual({ completed: 2, dead: 1 });
    const r = await pool.query(
      `SELECT idempotency_key FROM meeting_webhook_events ORDER BY idempotency_key`,
    );
    expect(r.rows.map((x) => x.idempotency_key)).toEqual([
      'fresh-dead',
      'fresh-delivered',
      'fresh-discarded',
      'old-pending',
      'old-processing',
    ]);
  });

  it('finish-методы меняют только processing и не перезаписывают терминальные состояния', async () => {
    const ids: Record<string, string> = {};
    for (const status of ['pending', 'delivered', 'discarded', 'dead']) {
      await store.enqueue(event({ idempotencyKey: `guard-${status}` }));
      const r = await pool.query(
        `UPDATE meeting_webhook_events
            SET status = $1,
                last_error = CASE WHEN $1 = 'discarded' THEN 'original'
                                  WHEN $1 = 'dead' THEN 'dead-original-error'
                                  ELSE NULL END,
                delivered_at = CASE WHEN $1 = 'delivered' THEN now() ELSE NULL END,
                updated_at = CASE WHEN $1 = 'dead' THEN now() - interval '3 days'
                                  ELSE now() - interval '5 seconds' END
          WHERE idempotency_key = $2
          RETURNING id`,
        [status, `guard-${status}`],
      );
      ids[status] = r.rows[0].id;
      expect(typeof ids[status]).toBe('string');
    }
    const snapshot = async () =>
      (await pool.query(
        `SELECT id::text AS id, status, attempts, last_error, next_retry_at, delivered_at, updated_at
           FROM meeting_webhook_events ORDER BY id`,
      )).rows;
    const before = await snapshot();
    const retryAt = new Date(Date.now() + 60_000);
    for (const id of Object.values(ids)) {
      await store.markDelivered(id);
      await store.markDiscarded(id, 'late discard');
      await store.markFailed(id, 1, 'late failure', retryAt);
      await store.markFailed(id, 10, 'late dead', retryAt);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('ошибки обрезаются до 500 символов, delivered очищает last_error', async () => {
    const lastError = async () =>
      (await pool.query(`SELECT status, last_error FROM meeting_webhook_events`)).rows[0];
    const makeDue = () =>
      pool.query(`UPDATE meeting_webhook_events SET next_retry_at = now() - interval '1 second'`);

    await store.enqueue(event());
    const [c1] = await store.claimBatch();
    await store.markFailed(c1.id, c1.attempts, 'f'.repeat(600), new Date(Date.now() - 1000));
    let row = await lastError();
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('f'.repeat(500));

    await makeDue();
    const [c2] = await store.claimBatch();
    await store.markDelivered(c2.id);
    row = await lastError();
    expect(row.status).toBe('delivered');
    expect(row.last_error).toBeNull();

    await pool.query('DELETE FROM meeting_webhook_events');
    await store.enqueue(event({ idempotencyKey: 'trunc-discard' }));
    const [c3] = await store.claimBatch();
    await store.markDiscarded(c3.id, 'd'.repeat(600));
    row = await lastError();
    expect(row.status).toBe('discarded');
    expect(row.last_error).toBe('d'.repeat(500));
  });
});
