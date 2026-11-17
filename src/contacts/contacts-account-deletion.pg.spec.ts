import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { coreTableDdl } from '../base/core-schema-ddl.forspec';
import {
  discoverContactsDeletion,
  ContactsAccountDeletionAdapter,
} from './contacts-account-deletion.adapter';
import { ContactsService } from './contacts.service';

/**
 * T17B-M2 — contacts.purge против живой PostgreSQL (до этого — только фейк
 * contacts-account-deletion.adapter.spec.ts и сквозной synthetic).
 *
 * Схема — из настоящих источников: user_id / ai_profiles_consolidated /
 * contact_requests вынимаются из снимка 001_core_schema.sql (модульной
 * миграции у contacts нет; core-schema-ddl.forspec.ts), deleted_at /
 * deletion_id — миграция account-deletion. Своя схема на спеку, удаляется
 * в afterAll.
 *
 * Закрепляемый контракт адаптера (шапка contacts-account-deletion.adapter.ts):
 *  - у СВОИХ заявок (requester_id = surrogate удалённого) message → NULL,
 *    строки, status, created_at, resolved_at сохраняются;
 *  - заявки В АДРЕС удалённого и между третьими не трогаются (их текст — не
 *    его данные);
 *  - profile shell (ai_profiles_consolidated) и surrogate id не меняются;
 *  - живой партнёр продолжает работать со своей входящей историей: pending
 *    от удалённого остаётся pending, partner может её разрешить;
 *  - нет profile shell / чужое поколение — тихий успех без записи;
 *  - повторный прогон — no-op.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `contacts_acct_del_spec_${process.pid}`;
const ACCOUNT_DELETION_MIGRATION = path.join(
  __dirname, '..', 'account-deletion', 'migrations', '001_account_deletion.sql',
);

// Синтетические номера (публичный репозиторий).
const DELETED = '79990000601';
const PARTNER = '79990000602';
const THIRD = '79990000603';
const NO_SHELL = '79990000604';
const DELETION_ID = '3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a090';
const OTHER_DELETION_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const OWN_CANARY = 'ЛИЧНОЕ-СООБЩЕНИЕ-УДАЛЁННОГО';

function jobRow(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-contacts-purge',
    deletionId: DELETION_ID,
    userId: DELETED,
    resourceType: 'contacts.purge',
    resourceKey: 'contacts',
    phase: 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-01T00:00:00Z'),
    leaseUntil: new Date('2026-12-01T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

maybe('contacts.purge against PostgreSQL (T17B-M2)', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  let adapter: ContactsAccountDeletionAdapter;
  const ids: Record<string, number> = {};

  function makeCtx(): DeletionExecution & { assertCurrent: jest.Mock } {
    return {
      db: { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) },
      assertCurrent: jest.fn(async () => undefined),
    };
  }

  async function rows(sql: string, params: any[] = []): Promise<any[]> {
    return (await pool.query(sql, params)).rows;
  }

  async function seedUser(
    phone: string,
    state: 'active' | 'deleted',
    deletionId: string | null = null,
    withShell = true,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO user_id (internal_id, primary_phone, state, deleted_at, deletion_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [phone, phone, state, state === 'deleted' ? DELETED_AT : null, deletionId],
    );
    if (!withShell) return;
    const r = await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, profile_data)
       VALUES ($1, '{}'::jsonb) RETURNING id`,
      [phone],
    );
    ids[phone] = r.rows[0].id;
  }

  async function seedRequest(
    from: string,
    to: string,
    message: string | null,
    status: 'pending' | 'approved' | 'rejected' | 'cancelled',
    createdAt: string,
  ): Promise<number> {
    const resolvedAt = status === 'pending'
      ? null
      : new Date(new Date(createdAt).getTime() + 3_600_000);
    const r = await pool.query(
      `INSERT INTO contact_requests (requester_id, target_id, message, status, created_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [ids[from], ids[to], message, status, createdAt, resolvedAt],
    );
    return r.rows[0].id;
  }

  /** contact_requests целиком (с метками времени) и профильные shell'ы. */
  async function snapshot(): Promise<{ requests: any[]; shells: any[] }> {
    return {
      requests: await rows(
        `SELECT id, requester_id, target_id, message, status, created_at, resolved_at
           FROM contact_requests ORDER BY id`,
      ),
      shells: await rows(`SELECT id, user_id FROM ai_profiles_consolidated ORDER BY id`),
    };
  }

  /**
   * Удалённый: исходящая pending живому партнёру (его входящая история),
   * старая отклонённая ему же, approved третьему; входящая от партнёра;
   * переписка третьего с партнёром.
   */
  async function seedHistory(): Promise<Record<string, number>> {
    return {
      ownPending: await seedRequest(DELETED, PARTNER, OWN_CANARY, 'pending', '2026-10-01T00:00:00Z'),
      ownRejected: await seedRequest(DELETED, PARTNER, `${OWN_CANARY}-старое`, 'rejected', '2026-09-01T00:00:00Z'),
      ownApproved: await seedRequest(DELETED, THIRD, `${OWN_CANARY}-третьему`, 'approved', '2026-10-02T00:00:00Z'),
      ownNoMessage: await seedRequest(DELETED, THIRD, null, 'cancelled', '2026-08-01T00:00:00Z'),
      incoming: await seedRequest(PARTNER, DELETED, 'партнёр пишет удалённому', 'pending', '2026-10-03T00:00:00Z'),
      foreign: await seedRequest(THIRD, PARTNER, 'третий пишет партнёру', 'approved', '2026-10-04T00:00:00Z'),
    };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });
    await pool.query(coreTableDdl(['user_id', 'ai_profiles_consolidated', 'contact_requests']));
    await pool.query(fs.readFileSync(ACCOUNT_DELETION_MIGRATION, 'utf8'));
    adapter = new ContactsAccountDeletionAdapter(new AccountDeletionRegistry());
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE contact_requests, ai_profiles_consolidated, user_id RESTART IDENTITY`);
    for (const key of Object.keys(ids)) delete ids[key];
    await seedUser(DELETED, 'deleted', DELETION_ID);
    await seedUser(PARTNER, 'active');
    await seedUser(THIRD, 'active');
  });

  it('discovery на живой схеме: generation gate находит поколение — stop+purge, пустые payload', async () => {
    const db = { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) };

    await expect(discoverContactsDeletion({
      db, account: { userId: DELETED, deletionId: DELETION_ID, deletedAt: DELETED_AT }, origin: 'explicit',
    })).resolves.toEqual({
      jobs: [
        { resourceType: 'contacts.stop', resourceKey: 'contacts', phase: 'immediate', payload: {} },
        { resourceType: 'contacts.purge', resourceKey: 'contacts', phase: 'purge', payload: {} },
      ],
      skips: [],
    });
    await expect(discoverContactsDeletion({
      db, account: { userId: DELETED, deletionId: OTHER_DELETION_ID, deletedAt: DELETED_AT }, origin: 'explicit',
    })).resolves.toEqual({ jobs: [], skips: [] });
  });

  it('свои заявки: message → NULL, строки/статусы/время целы; чужие тексты и shell не тронуты', async () => {
    const r = await seedHistory();
    const before = await snapshot();
    const ctx = makeCtx();

    await adapter.execute(jobRow(), ctx);

    const after = await snapshot();
    const byId = (s: { requests: any[] }) => new Map(s.requests.map((row) => [row.id, row]));
    const was = byId(before);
    const now = byId(after);
    expect(after.requests).toHaveLength(before.requests.length);
    for (const own of [r.ownPending, r.ownRejected, r.ownApproved, r.ownNoMessage]) {
      // Только message обнулён; всё остальное — как было.
      expect(now.get(own)).toEqual({ ...was.get(own), message: null });
    }
    expect(now.get(r.incoming)).toEqual(was.get(r.incoming));
    expect(now.get(r.foreign)).toEqual(was.get(r.foreign));
    // Profile shell и surrogate id не меняются (phoneById/idByPhone целы).
    expect(after.shells).toEqual(before.shells);
    expect(JSON.stringify(after)).not.toContain(OWN_CANARY);
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'contacts.purge' }),
    );
  });

  it('живой партнёр: pending от удалённого остаётся pending без текста и разрешается им как обычно', async () => {
    const r = await seedHistory();
    await adapter.execute(jobRow(), makeCtx());
    const service = new ContactsService({ query: (sql: string, p?: any[]) => pool.query(sql, p) } as any, undefined as any);

    // Входящая история партнёра по-прежнему адресуема через surrogate удалённого.
    await expect(service.phoneById(ids[DELETED])).resolves.toBe(DELETED);
    const pending = await rows(
      `SELECT id, status, message FROM contact_requests WHERE target_id=$1 AND status='pending'`,
      [ids[PARTNER]],
    );
    expect(pending).toEqual([{ id: r.ownPending, status: 'pending', message: null }]);

    const resolved = await service.resolve(PARTNER, r.ownPending, 'rejected');

    expect(resolved).toMatchObject({ id: r.ownPending, status: 'rejected', message: null });
    expect(resolved!.resolved_at).not.toBeNull();
    // Партнёр не может разрешить заявку не в свой адрес — контракт resolve цел.
    await expect(service.resolve(PARTNER, r.incoming, 'approved')).resolves.toBeNull();
  });

  it('удалённый не создаёт новых заявок (active guard на живой схеме)', async () => {
    const service = new ContactsService({ query: (sql: string, p?: any[]) => pool.query(sql, p) } as any, undefined as any);

    await expect(service.createRequest(DELETED, ids[PARTNER], 'hi'))
      .rejects.toBeInstanceOf(BadRequestException);

    expect(await rows(`SELECT count(*)::int AS n FROM contact_requests`)).toEqual([{ n: 0 }]);
  });

  it('идемпотентность: повторный purge — тихий успех, снимок не меняется', async () => {
    await seedHistory();
    await adapter.execute(jobRow(), makeCtx());
    const first = await snapshot();

    await expect(adapter.execute(jobRow({ attempts: 2 }), makeCtx())).resolves.toBeUndefined();

    expect(await snapshot()).toEqual(first);
  });

  it('оба участника удалены: тексты обоих стёрты, заявки и переписка третьего целы', async () => {
    const r = await seedHistory();
    await pool.query(
      `UPDATE user_id SET state='deleted', deleted_at=$2, deletion_id=$3 WHERE internal_id=$1`,
      [PARTNER, DELETED_AT, OTHER_DELETION_ID],
    );
    const before = await snapshot();

    await adapter.execute(jobRow(), makeCtx());
    await adapter.execute(
      jobRow({ id: 'job-partner', userId: PARTNER, deletionId: OTHER_DELETION_ID }),
      makeCtx(),
    );

    const now = new Map((await snapshot()).requests.map((row) => [row.id, row]));
    const was = new Map(before.requests.map((row) => [row.id, row]));
    for (const id of [r.ownPending, r.ownRejected, r.ownApproved, r.ownNoMessage, r.incoming]) {
      expect(now.get(id)).toEqual({ ...was.get(id), message: null });
    }
    // Заявка третьего — его текст, не удалённых: цела.
    expect(now.get(r.foreign)).toEqual(was.get(r.foreign));
  });

  it('generation mismatch — тихий успех, ни одна строка не тронута', async () => {
    await seedHistory();
    const before = await snapshot();

    await expect(
      adapter.execute(jobRow({ deletionId: OTHER_DELETION_ID }), makeCtx()),
    ).resolves.toBeUndefined();
    // Реактивированный аккаунт (state='active', поколение то же) — тоже no-op.
    await pool.query(`UPDATE user_id SET state='active' WHERE internal_id=$1`, [DELETED]);
    await expect(adapter.execute(jobRow(), makeCtx())).resolves.toBeUndefined();

    expect(await snapshot()).toEqual(before);
  });

  it('нет profile shell — тихий успех, чужие заявки не тронуты', async () => {
    await seedUser(NO_SHELL, 'deleted', OTHER_DELETION_ID, false);
    await seedHistory();
    const before = await snapshot();

    await expect(
      adapter.execute(jobRow({ userId: NO_SHELL, deletionId: OTHER_DELETION_ID }), makeCtx()),
    ).resolves.toBeUndefined();

    expect(await snapshot()).toEqual(before);
  });

  it('reactivation до записи — DeletionCancelledError, тексты целы', async () => {
    await seedHistory();
    const before = await snapshot();
    const ctx = makeCtx();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(jobRow(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);

    expect(await snapshot()).toEqual(before);
  });

  it('сбой БД на UPDATE — DeletionRetryError(db), повтор доводит до того же итога', async () => {
    await seedHistory();
    let n = 0;
    const failing: DeletionExecution = {
      db: {
        query: async (sql: string, params?: unknown[]) => {
          n += 1;
          if (n === 2) throw Object.assign(new Error('connection terminated (spec)'), { code: '08006' });
          return pool.query(sql, params as any[]);
        },
      },
      assertCurrent: jest.fn(async () => undefined),
    };

    const error = await adapter.execute(jobRow(), failing).catch((e) => e);
    expect(error).toBeInstanceOf(DeletionRetryError);
    expect(error.kind).toBe('db');
    expect(JSON.stringify(await snapshot())).toContain(OWN_CANARY);

    await adapter.execute(jobRow({ attempts: 2 }), makeCtx());
    expect(JSON.stringify(await snapshot())).not.toContain(OWN_CANARY);
  });
});
