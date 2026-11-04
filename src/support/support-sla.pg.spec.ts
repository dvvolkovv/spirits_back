jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { SupportService } from './support.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `support_sla_spec_${process.pid}`;
const MIGRATION = path.join(__dirname, 'migrations', '002_support_sla.sql');

maybe('support SLA migration against PostgreSQL', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;

  async function ticket(createdAt: string, urgency: string | null): Promise<string> {
    const r = await pool.query(
      `INSERT INTO support_tickets (user_id, urgency, created_at)
       VALUES ($1, $2, $3::timestamptz) RETURNING id`,
      [`user-${createdAt}-${urgency}`, urgency, createdAt],
    );
    return r.rows[0].id;
  }

  async function applyMigration(): Promise<void> {
    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '001_support.sql'), 'utf8'));

    const escalated = await ticket('2026-01-01T00:00:00.000Z', 'high');
    await pool.query(
      `INSERT INTO support_events (ticket_id, actor_type, action, created_at)
       VALUES ($1, 'ai', 'escalate', '2026-01-01T03:00:00.000Z'),
              ($1, 'ai', 'escalate', '2026-01-01T02:00:00.000Z')`,
      [escalated],
    );

    await ticket('2026-01-02T00:00:00.000Z', null);

    const replied = await ticket('2026-01-03T00:00:00.000Z', 'critical');
    await pool.query(
      `INSERT INTO support_messages (ticket_id, sender_type, content, visible_to_user, created_at)
       VALUES ($1, 'owner', 'internal note', false, '2026-01-03T00:05:00.000Z'),
              ($1, 'owner', 'visible reply', true, '2026-01-03T00:10:00.000Z'),
              ($1, 'owner', 'later reply', true, '2026-01-03T00:20:00.000Z')`,
      [replied],
    );

    const internalOnly = await ticket('2026-01-04T00:00:00.000Z', 'normal');
    await pool.query(
      `INSERT INTO support_messages (ticket_id, sender_type, content, visible_to_user, created_at)
       VALUES ($1, 'owner', 'internal note', false, '2026-01-04T00:05:00.000Z')`,
      [internalOnly],
    );

    await applyMigration();

    await pool.query(`
      CREATE TABLE ai_profiles_consolidated (
        user_id text PRIMARY KEY,
        profile_data jsonb NOT NULL DEFAULT '{}',
        tokens bigint NOT NULL DEFAULT 0,
        isadmin boolean NOT NULL DEFAULT false
      );
      CREATE TABLE user_id (
        internal_id text PRIMARY KEY,
        state text NOT NULL DEFAULT 'active'
      );
      INSERT INTO ai_profiles_consolidated (user_id, profile_data, isadmin) VALUES
        ('admin-b', '{"name":"Bob"}', true),
        ('admin-a', '{"first_name":"Alice"}', true),
        ('admin-deleted', '{"name":"Deleted"}', true),
        ('not-admin', '{"name":"Not Admin"}', false);
      INSERT INTO user_id (internal_id, state) VALUES
        ('admin-a', 'active'), ('admin-b', 'active'),
        ('admin-deleted', 'deleted'), ('not-admin', 'active');
    `);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('uses the earliest escalation event for the response due date', async () => {
    const r = await pool.query(
      `SELECT first_response_due_at FROM support_tickets
       WHERE created_at = '2026-01-01T00:00:00.000Z'::timestamptz`,
    );
    expect(r.rows[0].first_response_due_at.toISOString()).toBe('2026-01-01T03:00:00.000Z');
  });

  it('falls back to created_at and normal urgency without an escalation event', async () => {
    const r = await pool.query(
      `SELECT first_response_due_at FROM support_tickets
       WHERE created_at = '2026-01-02T00:00:00.000Z'::timestamptz`,
    );
    expect(r.rows[0].first_response_due_at.toISOString()).toBe('2026-01-02T04:00:00.000Z');
  });

  it('backfills the first visible owner reply and ignores internal notes', async () => {
    const r = await pool.query(
      `SELECT created_at, first_owner_reply_at FROM support_tickets
       WHERE created_at IN ('2026-01-03T00:00:00.000Z'::timestamptz,
                            '2026-01-04T00:00:00.000Z'::timestamptz)
       ORDER BY created_at`,
    );
    expect(r.rows[0].first_owner_reply_at.toISOString()).toBe('2026-01-03T00:10:00.000Z');
    expect(r.rows[1].first_owner_reply_at).toBeNull();
  });

  it('adds nullable assignment and SLA columns with due and assignee indexes', async () => {
    const columns = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'support_tickets'
         AND column_name IN ('assigned_to', 'assigned_at', 'first_response_due_at', 'first_owner_reply_at')
       ORDER BY column_name`,
      [SCHEMA],
    );
    expect(columns.rows).toEqual([
      { column_name: 'assigned_at', is_nullable: 'YES' },
      { column_name: 'assigned_to', is_nullable: 'YES' },
      { column_name: 'first_owner_reply_at', is_nullable: 'YES' },
      { column_name: 'first_response_due_at', is_nullable: 'YES' },
    ]);

    const indexes = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'support_tickets'
         AND indexname IN ('idx_support_tickets_first_response_due_at', 'idx_support_tickets_assigned_to')
       ORDER BY indexname`,
      [SCHEMA],
    );
    expect(indexes.rows).toEqual([
      { indexname: 'idx_support_tickets_assigned_to' },
      { indexname: 'idx_support_tickets_first_response_due_at' },
    ]);
  });

  it('can be applied repeatedly without changing backfilled values', async () => {
    const before = await pool.query(
      `SELECT id, first_response_due_at, first_owner_reply_at FROM support_tickets ORDER BY id`,
    );

    await applyMigration();

    const after = await pool.query(
      `SELECT id, first_response_due_at, first_owner_reply_at FROM support_tickets ORDER BY id`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('serializes concurrent service initialization without changing the backfill', async () => {
    const slaSnapshot = `SELECT id, first_response_due_at, first_owner_reply_at FROM support_tickets ORDER BY id`;
    const before = await pool.query(slaSnapshot);
    await pool.query(
      'UPDATE support_tickets SET first_response_due_at = NULL, first_owner_reply_at = NULL',
    );
    const clients: unknown[] = [];
    const pg = {
      getClient: async () => {
        const client = await pool.connect();
        clients.push(client);
        return client;
      },
    };

    await Promise.all([
      new SupportService(pg as any).onModuleInit(),
      new SupportService(pg as any).onModuleInit(),
    ]);

    expect(new Set(clients).size).toBe(2);
    expect((await pool.query(slaSnapshot)).rows).toEqual(before.rows);
  });

  it('lists only active admins ordered by their display name', async () => {
    const service = new SupportService({
      query: pool.query.bind(pool), getClient: () => pool.connect(),
    } as any);

    await expect(service.adminOperators()).resolves.toEqual([
      { id: 'admin-a', name: 'Alice' },
      { id: 'admin-b', name: 'Bob' },
    ]);
  });

  it('allows exactly one of two assignments with the same expectedUpdatedAt', async () => {
    const created = await pool.query(
      `INSERT INTO support_tickets (user_id) VALUES ('assignment-race-user')
       RETURNING id, updated_at`,
    );
    const { id } = created.rows[0];
    const expectedUpdatedAt = created.rows[0].updated_at.toISOString();
    const service = new SupportService({
      query: pool.query.bind(pool), getClient: () => pool.connect(),
    } as any);

    const results = await Promise.allSettled([
      service.assign('actor-a', id, { assigneeId: 'admin-a', expectedUpdatedAt }),
      service.assign('actor-b', id, { assigneeId: 'admin-b', expectedUpdatedAt }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.getStatus()).toBe(409);

    const stored = await pool.query('SELECT assigned_to, assigned_at, status FROM support_tickets WHERE id = $1', [id]);
    expect(stored.rows[0].assigned_to).toBe(fulfilled[0].value.assigned_to);
    expect(stored.rows[0].assigned_at).toBeInstanceOf(Date);
    expect(stored.rows[0].status).toBe('owner_handling');
    const events = await pool.query(
      "SELECT actor_id, payload FROM support_events WHERE ticket_id = $1 AND action = 'assignment'", [id],
    );
    expect(events.rows).toHaveLength(1);
  });

  it('rejects assignment of a resolved ticket without reopening it', async () => {
    const created = await pool.query(
      `INSERT INTO support_tickets (user_id, status) VALUES ('resolved-assignment-user', 'resolved')
       RETURNING id, updated_at`,
    );
    const { id } = created.rows[0];
    const service = new SupportService({
      query: pool.query.bind(pool), getClient: () => pool.connect(),
    } as any);

    await expect(service.assign('actor-a', id, {
      assigneeId: 'admin-a', expectedUpdatedAt: created.rows[0].updated_at.toISOString(),
    })).rejects.toMatchObject({ response: { statusCode: 400 } });

    const stored = await pool.query('SELECT status, assigned_to FROM support_tickets WHERE id = $1', [id]);
    expect(stored.rows[0]).toEqual({ status: 'resolved', assigned_to: null });
    const events = await pool.query(
      "SELECT id FROM support_events WHERE ticket_id = $1 AND action = 'assignment'", [id],
    );
    expect(events.rows).toHaveLength(0);
  });

  function makeService(pg: any = {
    query: pool.query.bind(pool), getClient: () => pool.connect(),
  }): SupportService {
    return new SupportService(pg);
  }

  async function newTicket(status = 'escalated'): Promise<string> {
    const r = await pool.query(
      `INSERT INTO support_tickets (user_id, status) VALUES ($1, $2) RETURNING id`,
      [`runtime-${Date.now()}-${Math.random()}`, status],
    );
    return r.rows[0].id;
  }

  it('sets the runtime due date from the first escalation and enters the soon queue without another migration', async () => {
    const service = makeService();
    const id = await newTicket('ai_handling');
    const before = Date.now();

    const first = await (service as any).executeTool(id, 'runtime-user', 'escalate_to_owner', {
      reason: 'human needed', urgency: 'critical', summary: 'runtime SLA',
    });
    const after = Date.now();

    expect(first).toEqual({ ok: true, escalated: true });
    const stored = await pool.query(
      'SELECT first_response_due_at FROM support_tickets WHERE id = $1', [id],
    );
    expect(stored.rows[0].first_response_due_at).toBeInstanceOf(Date);
    const dueMs = stored.rows[0].first_response_due_at.getTime();
    expect(dueMs).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(dueMs).toBeLessThanOrEqual(after + 15 * 60_000);
    const soon = await service.adminListTickets({ sla: 'soon' });
    expect(soon.map((t) => t.id)).toContain(id);

    await (service as any).executeTool(id, 'runtime-user', 'escalate_to_owner', {
      reason: 'escalated again', urgency: 'low', summary: 'must not move the first deadline',
    });
    const afterSecond = await pool.query(
      'SELECT first_response_due_at FROM support_tickets WHERE id = $1', [id],
    );
    expect(afterSecond.rows[0].first_response_due_at).toEqual(stored.rows[0].first_response_due_at);
  });

  const replyChannels: Array<[string, (service: SupportService, id: string) => Promise<void>]> = [
    ['admin', (service, id) => service.adminReply(id, 'admin-a', 'atomic reply')],
    ['telegram', (service, id) => service.postOwnerReplyFromTelegram(id, 'telegram-1', 'Owner', 'atomic reply')],
  ];

  it.each(replyChannels)('%s reply rolls back completely and retry does not duplicate writes', async (_channel, reply) => {
    const service = makeService();
    const id = await newTicket();
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_support_reply_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced reply event failure'; END $$;
      DROP TRIGGER IF EXISTS fail_reply_event ON support_events;
      CREATE TRIGGER fail_reply_event BEFORE INSERT ON support_events
      FOR EACH ROW WHEN (NEW.action = 'reply') EXECUTE FUNCTION fail_support_reply_event();
    `);

    await expect(reply(service, id)).rejects.toThrow('forced reply event failure');
    await pool.query('DROP TRIGGER fail_reply_event ON support_events');

    const rolledBack = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM support_messages WHERE ticket_id = $1 AND sender_type = 'owner') AS messages,
         (SELECT count(*)::int FROM support_events WHERE ticket_id = $1 AND action = 'reply') AS events,
         (SELECT status || ':' || COALESCE(first_owner_reply_at::text, 'null')
            FROM support_tickets WHERE id = $1) AS ticket`,
      [id],
    );
    expect(rolledBack.rows[0]).toEqual({ messages: 0, events: 0, ticket: 'escalated:null' });

    await reply(service, id);

    const retried = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM support_messages WHERE ticket_id = $1 AND sender_type = 'owner') AS messages,
         (SELECT count(*)::int FROM support_events WHERE ticket_id = $1 AND action = 'reply') AS events,
         (SELECT status FROM support_tickets WHERE id = $1) AS status,
         (SELECT first_owner_reply_at FROM support_tickets WHERE id = $1) AS marker,
         (SELECT created_at FROM support_messages WHERE ticket_id = $1 AND sender_type = 'owner') AS message_at`,
      [id],
    );
    expect(retried.rows[0]).toMatchObject({ messages: 1, events: 1, status: 'owner_handling' });
    expect(retried.rows[0].marker).toEqual(retried.rows[0].message_at);
  });

  it('keeps the actual earliest visible reply timestamp under overlapping transactions', async () => {
    const id = await newTicket();
    const normal = makeService();
    let announceInserted!: () => void;
    const inserted = new Promise<void>((resolve) => { announceInserted = resolve; });
    let continueReply!: () => void;
    const gate = new Promise<void>((resolve) => { continueReply = resolve; });
    const wrap = (raw: (sql: string, params?: any[]) => Promise<any>) => async (sql: string, params?: any[]) => {
      const result = await raw(sql, params);
      if (/INSERT INTO support_messages/.test(sql)) {
        await raw('UPDATE support_messages SET created_at = $1 WHERE id = $2', [
          new Date('2020-01-01T00:00:00.000Z'), result.rows[0].id,
        ]);
        announceInserted();
        await gate;
      }
      return result;
    };
    const delayed = makeService({
      query: wrap(pool.query.bind(pool)),
      getClient: async () => {
        const client = await pool.connect();
        return { query: wrap(client.query.bind(client)), release: client.release.bind(client) };
      },
    });

    const earlier = delayed.adminReply(id, 'admin-a', 'earlier visible reply');
    await inserted;
    const later = normal.adminReply(id, 'admin-b', 'later visible reply');
    await new Promise((resolve) => setTimeout(resolve, 50));
    continueReply();
    await Promise.all([earlier, later]);

    const result = await pool.query(
      `SELECT t.first_owner_reply_at,
              (SELECT array_agg(m.content ORDER BY m.created_at, m.id)
                 FROM support_messages m
                WHERE m.ticket_id = t.id AND m.sender_type = 'owner' AND m.visible_to_user = true) AS contents,
              (SELECT min(m.created_at)
                 FROM support_messages m
                WHERE m.ticket_id = t.id AND m.sender_type = 'owner' AND m.visible_to_user = true) AS earliest
         FROM support_tickets t WHERE t.id = $1`,
      [id],
    );
    expect(result.rows[0].contents).toEqual(['earlier visible reply', 'later visible reply']);
    expect(result.rows[0].first_owner_reply_at).toEqual(result.rows[0].earliest);
  });

  it('filters and orders real queue rows by SLA, urgency, status, and actor', async () => {
    await pool.query('TRUNCATE support_tickets CASCADE');
    const service = makeService();
    async function queueTicket(
      urgency: string, status: string, actor: string | null,
      due: Date | null, replied: Date | null = null,
    ): Promise<string> {
      const r = await pool.query(
        `INSERT INTO support_tickets
           (user_id, urgency, status, assigned_to, first_response_due_at, first_owner_reply_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [`queue-${Math.random()}`, urgency, status, actor, due, replied],
      );
      return r.rows[0].id;
    }
    const overdueCritical = await queueTicket('critical', 'escalated', 'admin-a', new Date(Date.now() - 60_000));
    const overdueLow = await queueTicket('low', 'owner_handling', 'admin-a', new Date(Date.now() - 120_000));
    const soonCritical = await queueTicket('critical', 'escalated', 'admin-b', new Date(Date.now() + 10 * 60_000));
    const soonLow = await queueTicket('low', 'escalated', 'admin-a', new Date(Date.now() + 20 * 60_000));
    const repliedCritical = await queueTicket(
      'critical', 'escalated', 'admin-a', new Date(Date.now() - 180_000), new Date(),
    );
    const newNormal = await queueTicket('normal', 'ai_handling', 'admin-a', null);
    const newLow = await queueTicket('low', 'escalated', 'admin-b', null);
    const resolvedOverdue = await queueTicket('critical', 'resolved', null, new Date(Date.now() - 240_000));

    const all = await service.adminListTickets({ status: 'all', limit: 50 });
    expect(all.map((t) => t.id)).toEqual([
      overdueCritical, overdueLow, soonCritical, soonLow, repliedCritical, newNormal, newLow, resolvedOverdue,
    ]);
    expect(all[0]).toMatchObject({
      assignedTo: 'admin-a', assignedName: 'Alice', firstOwnerReplyAt: null,
    });
    expect(all[0].firstResponseDueAt).toEqual(expect.any(Date));

    const overdue = await service.adminListTickets({ sla: 'overdue' });
    expect(overdue.map((t) => t.id)).toEqual([overdueCritical, overdueLow]);
    const soon = await service.adminListTickets({ sla: 'soon' });
    expect(soon.map((t) => t.id)).toEqual([soonCritical, soonLow]);
    expect([...overdue, ...soon].map((t) => t.id)).not.toContain(repliedCritical);

    const mineEscalated = await service.adminListTickets({
      status: 'escalated', sla: 'mine', actorId: 'admin-a',
    });
    expect(mineEscalated.map((t) => t.id)).toEqual([overdueCritical, soonLow, repliedCritical]);
  });
});
