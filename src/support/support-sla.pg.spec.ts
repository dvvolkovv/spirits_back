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
});
