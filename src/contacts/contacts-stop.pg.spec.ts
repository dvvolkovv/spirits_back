import { NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
  safeDeletionJobSnapshot,
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
 * K6 — contacts.stop против живой PostgreSQL (форма peer.stop).
 *
 * peer.stop переводит висящие заявки удалённого в 'withdrawn' с
 * responded_at=now(). У contacts тот же смысл несёт уже существующий статус
 * 'cancelled' (ContactRequest.status, бейдж «Отменён» на фронте; CHECK в
 * схеме нет) с resolved_at=now(). contacts.stop (immediate) отменяет ВСЕ
 * pending-заявки, где удалённый — отправитель ИЛИ получатель: висящая заявка
 * удалённого больше не может быть одобрена (и раскрыть его телефон), а
 * заявка живого человека к удалённому не висит вечно в «Ожидает».
 * Обработанные (approved/rejected/cancelled) и чужие заявки не трогаются,
 * текст не стирается — это работа contacts.purge после retention.
 *
 * Схема — настоящие DDL: user_id / ai_profiles_consolidated /
 * contact_requests из снимка 001_core_schema.sql, миграция account-deletion
 * и peer-миграция (списки контактов читают peer_conversations/user_blocks).
 * Своя схема на спеку.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `contacts_stop_spec_${process.pid}`;
const MIGRATIONS = [
  path.join(__dirname, '..', 'account-deletion', 'migrations', '001_account_deletion.sql'),
  path.join(__dirname, '..', 'peer', 'migrations', '001_peer_tables.sql'),
];

// Синтетические номера (публичный репозиторий).
const DELETED = '79990000651';
const PARTNER = '79990000652';
const LIVE = '79990000653';
const THIRD = '79990000654';
const NO_SHELL = '79990000655';
const DELETION_ID = '2e1d0c9b-8a7f-4e6d-9c5b-4a3f2e1d0c9b';
const OTHER_DELETION_ID = '5b4a3f2e-1d0c-4b9a-8f7e-6d5c4b3a2f1e';
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const OWN_CANARY = 'ТЕКСТ-ЗАЯВКИ-УДАЛЁННОГО';

function stopJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-contacts-stop',
    deletionId: DELETION_ID,
    userId: DELETED,
    resourceType: 'contacts.stop' as DeletionJobRow['resourceType'],
    resourceKey: 'contacts',
    phase: 'immediate',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-01T00:00:00Z'),
    leaseUntil: new Date('2026-11-01T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

maybe('contacts.stop against PostgreSQL (K6)', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  let adapter: ContactsAccountDeletionAdapter;
  const ids: Record<string, number> = {};
  let r: Record<string, number>;

  const db = { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) };

  function makeCtx(): DeletionExecution & { assertCurrent: jest.Mock } {
    return { db, assertCurrent: jest.fn(async () => undefined) };
  }

  async function rows(sql: string, params: any[] = []): Promise<any[]> {
    return (await pool.query(sql, params)).rows;
  }

  async function seedUser(phone: string, state: string, deletionId: string | null, withShell = true) {
    await pool.query(
      `INSERT INTO user_id (internal_id, primary_phone, state, deleted_at, deletion_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [phone, phone, state, state === 'deleted' ? DELETED_AT : null, deletionId],
    );
    if (!withShell) return;
    const res = await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, profile_data) VALUES ($1, '{}'::jsonb) RETURNING id`,
      [phone],
    );
    ids[phone] = res.rows[0].id;
  }

  async function seedRequest(
    from: string,
    to: string,
    message: string | null,
    status: 'pending' | 'approved' | 'rejected' | 'cancelled',
    createdAt: string,
  ): Promise<number> {
    const resolvedAt = status === 'pending' ? null : new Date(new Date(createdAt).getTime() + 3_600_000);
    const res = await pool.query(
      `INSERT INTO contact_requests (requester_id, target_id, message, status, created_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ids[from], ids[to], message, status, createdAt, resolvedAt],
    );
    return res.rows[0].id;
  }

  async function snapshot(): Promise<Map<number, any>> {
    const list = await rows(
      `SELECT id, requester_id, target_id, message, status, created_at, resolved_at
         FROM contact_requests ORDER BY id`,
    );
    return new Map(list.map((row) => [row.id, row]));
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });
    await pool.query(coreTableDdl(['user_id', 'ai_profiles_consolidated', 'contact_requests']));
    for (const file of MIGRATIONS) await pool.query(fs.readFileSync(file, 'utf8'));
    adapter = new ContactsAccountDeletionAdapter(new AccountDeletionRegistry());
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE contact_requests, ai_profiles_consolidated, user_id, peer_conversations,
                user_blocks RESTART IDENTITY CASCADE`,
    );
    for (const key of Object.keys(ids)) delete ids[key];
    await seedUser(DELETED, 'deleted', DELETION_ID);
    await seedUser(PARTNER, 'active', null);
    await seedUser(LIVE, 'active', null);
    await seedUser(THIRD, 'active', null);
    r = {
      // Висящие: удалённый — отправитель и удалённый — получатель.
      outPending: await seedRequest(DELETED, PARTNER, OWN_CANARY, 'pending', '2026-10-01T00:00:00Z'),
      inPending: await seedRequest(LIVE, DELETED, 'живой пишет удалённому', 'pending', '2026-10-02T00:00:00Z'),
      // Обработанные — история, stop их не трогает.
      outApproved: await seedRequest(DELETED, THIRD, `${OWN_CANARY}-одобрена`, 'approved', '2026-09-01T00:00:00Z'),
      inRejected: await seedRequest(PARTNER, DELETED, 'старая отклонённая', 'rejected', '2026-08-01T00:00:00Z'),
      outCancelled: await seedRequest(DELETED, LIVE, null, 'cancelled', '2026-07-01T00:00:00Z'),
      // Чужая висящая заявка между живыми.
      foreignPending: await seedRequest(LIVE, PARTNER, 'чужая заявка', 'pending', '2026-10-03T00:00:00Z'),
    };
  });

  it('discovery: contacts.stop immediate + contacts.purge purge, пустые payload, sanitizer проходит', async () => {
    const plan = await discoverContactsDeletion({
      db, account: { userId: DELETED, deletionId: DELETION_ID, deletedAt: DELETED_AT }, origin: 'explicit',
    });

    expect(plan).toEqual({
      jobs: [
        { resourceType: 'contacts.stop', resourceKey: 'contacts', phase: 'immediate', payload: {} },
        { resourceType: 'contacts.purge', resourceKey: 'contacts', phase: 'purge', payload: {} },
      ],
      skips: [],
    });
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, DELETED)).not.toThrow();
    }
    await expect(discoverContactsDeletion({
      db, account: { userId: DELETED, deletionId: OTHER_DELETION_ID, deletedAt: DELETED_AT }, origin: 'merge',
    })).resolves.toEqual({ jobs: [], skips: [] });
  });

  it('stop: висящие заявки в обе стороны → cancelled с resolved_at; обработанные и чужие целы, текст не стирается', async () => {
    const before = await snapshot();
    const startedAt = (await rows(`SELECT now() AS t`))[0].t as Date;
    const ctx = makeCtx();

    await adapter.execute(stopJob(), ctx);

    const after = await snapshot();
    for (const id of [r.outPending, r.inPending]) {
      const row = after.get(id);
      expect(row).toEqual({ ...before.get(id), status: 'cancelled', resolved_at: row.resolved_at });
      expect(row.resolved_at).not.toBeNull();
      expect(row.resolved_at.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    }
    // Текст своей заявки до purge остаётся (stop его не трогает).
    expect(after.get(r.outPending).message).toBe(OWN_CANARY);
    for (const id of [r.outApproved, r.inRejected, r.outCancelled, r.foreignPending]) {
      expect(after.get(id)).toEqual(before.get(id));
    }
    expect(ctx.assertCurrent).toHaveBeenCalledTimes(1);
    expect(ctx.assertCurrent).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'contacts.stop' }));
  });

  it('что видят обе стороны после stop: «Отменён», без телефона, одобрить нельзя', async () => {
    await adapter.execute(stopJob(), makeCtx());
    const service = new ContactsService({ query: (sql: string, p?: any[]) => pool.query(sql, p) } as any, undefined as any);

    // Партнёр, которому удалённый отправил заявку: входящая «Отменён».
    const incoming = (await service.listIncoming(PARTNER)).find((row) => row.id === r.outPending);
    expect(incoming).toMatchObject({ status: 'cancelled' });
    expect(incoming!.resolved_at).not.toBeNull();
    expect(incoming).not.toHaveProperty('requester_phone');
    // Одобрить отменённую нельзя — прежний отказ «не найдена / не pending».
    await expect(service.resolve(PARTNER, r.outPending, 'approved')).resolves.toBeNull();
    await expect(service.resolve(PARTNER, r.outPending, 'rejected')).resolves.toBeNull();

    // Живой, отправивший заявку удалённому: исходящая «Отменён».
    const outgoing = (await service.listOutgoing(LIVE)).find((row) => row.id === r.inPending);
    expect(outgoing).toMatchObject({ status: 'cancelled' });
    expect(outgoing!.resolved_at).not.toBeNull();
    expect(outgoing).not.toHaveProperty('target_phone');

    // Чужая висящая заявка по-прежнему разрешается партнёром.
    await expect(service.resolve(PARTNER, r.foreignPending, 'approved'))
      .resolves.toMatchObject({ status: 'approved', requester_phone: LIVE });
  });

  it('идемпотентность: повторный stop — тихий успех, resolved_at не сдвигается', async () => {
    await adapter.execute(stopJob(), makeCtx());
    const first = await snapshot();

    await expect(adapter.execute(stopJob({ attempts: 2 }), makeCtx())).resolves.toBeUndefined();

    expect(await snapshot()).toEqual(first);
  });

  it('stop → purge: отменённые заявки остаются отменёнными, свой текст стёрт', async () => {
    await adapter.execute(stopJob(), makeCtx());
    await adapter.execute(stopJob({
      id: 'job-contacts-purge',
      resourceType: 'contacts.purge',
      phase: 'purge',
    }), makeCtx());

    const after = await snapshot();
    expect(after.get(r.outPending)).toMatchObject({ status: 'cancelled', message: null });
    expect(after.get(r.inPending)).toMatchObject({ status: 'cancelled', message: 'живой пишет удалённому' });
  });

  it('чужое поколение и реактивация — заявки не тронуты', async () => {
    const before = await snapshot();

    await expect(adapter.execute(stopJob({ deletionId: OTHER_DELETION_ID }), makeCtx())).resolves.toBeUndefined();
    await pool.query(`UPDATE user_id SET state='active' WHERE internal_id=$1`, [DELETED]);
    await expect(adapter.execute(stopJob(), makeCtx())).resolves.toBeUndefined();

    expect(await snapshot()).toEqual(before);
  });

  it('reactivation до записи (assertCurrent) — DeletionCancelledError, заявки не тронуты', async () => {
    const before = await snapshot();
    const ctx = makeCtx();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(stopJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);

    expect(await snapshot()).toEqual(before);
  });

  it('сбой БД — DeletionRetryError(db), повтор доводит до того же итога', async () => {
    const before = await snapshot();
    const failing: DeletionExecution = {
      db: {
        query: async () => {
          throw Object.assign(new Error('connection terminated (spec)'), { code: '08006' });
        },
      },
      assertCurrent: jest.fn(async () => undefined),
    };

    const error = await adapter.execute(stopJob(), failing).catch((e) => e);

    expect(error).toBeInstanceOf(DeletionRetryError);
    expect(error.kind).toBe('db');
    expect(await snapshot()).toEqual(before);
    await adapter.execute(stopJob({ attempts: 2 }), makeCtx());
    const after = await snapshot();
    expect(after.get(r.outPending).status).toBe('cancelled');
    expect(after.get(r.inPending).status).toBe('cancelled');
  });

  it('нет profile shell — тихий успех, чужие заявки не тронуты', async () => {
    await seedUser(NO_SHELL, 'deleted', OTHER_DELETION_ID, false);
    const before = await snapshot();

    await expect(
      adapter.execute(stopJob({ userId: NO_SHELL, deletionId: OTHER_DELETION_ID }), makeCtx()),
    ).resolves.toBeUndefined();

    expect(await snapshot()).toEqual(before);
  });

  describe('новые заявки неактивному получателю (K6b)', () => {
    const service = (pg?: any) =>
      new ContactsService(pg ?? ({ query: (sql: string, p?: any[]) => pool.query(sql, p) } as any), undefined as any);

    async function notAvailable(promise: Promise<unknown>): Promise<void> {
      const error = await promise.then(() => null, (e) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
    }

    async function requestsTo(phone: string): Promise<any[]> {
      return rows(
        `SELECT id, requester_id, status FROM contact_requests WHERE target_id=$1 ORDER BY id`,
        [ids[phone]],
      );
    }

    /** Заявки LIVE к получателю (посев уже содержит чужие заявки к THIRD). */
    async function fromLiveTo(phone: string): Promise<any[]> {
      return rows(
        `SELECT id, status FROM contact_requests WHERE requester_id=$1 AND target_id=$2 ORDER BY id`,
        [ids[LIVE], ids[phone]],
      );
    }

    it('после stop новая заявка удалённому не создаётся — тот же ответ, что на несуществующего', async () => {
      await adapter.execute(stopJob(), makeCtx());
      const before = await requestsTo(DELETED);

      await notAvailable(service().createRequest(LIVE, ids[DELETED], 'ещё раз'));

      expect(await requestsTo(DELETED)).toEqual(before);
      expect((await requestsTo(DELETED)).filter((row) => row.status === 'pending')).toEqual([]);
      // Форма ответа совпадает с несуществующим получателем.
      await notAvailable(service().createRequest(LIVE, 999_999, 'никому'));
    });

    it('заблокированный получатель и профиль без строки user_id — заявка не создаётся', async () => {
      await seedUser('79990000656', 'blocked', null);
      await seedUser('79990000657', 'active', null);
      await pool.query(`DELETE FROM user_id WHERE internal_id='79990000657'`);

      await notAvailable(service().createRequest(LIVE, ids['79990000656'], 'привет'));
      await notAvailable(service().createRequest(LIVE, ids['79990000657'], 'привет'));

      expect(await requestsTo('79990000656')).toEqual([]);
      expect(await requestsTo('79990000657')).toEqual([]);
    });

    it('получателя удалили между проверками и INSERT — гейт в самом INSERT, заявки нет', async () => {
      const racing = {
        query: async (sql: string, params?: any[]) => {
          // Видимость контакта читается после проверок получателя.
          if (sql.includes("profile_data->>'contactVisible'")) {
            await pool.query(
              `UPDATE user_id SET state='deleted', deleted_at=now(), deletion_id=gen_random_uuid()
                WHERE internal_id=$1`,
              [THIRD],
            );
          }
          return pool.query(sql, params);
        },
      };

      await notAvailable(service(racing).createRequest(LIVE, ids[THIRD], 'привет'));

      expect(await fromLiveTo(THIRD)).toEqual([]);
    });

    it('активный получатель — прежнее поведение: pending создана', async () => {
      const created = await service().createRequest(LIVE, ids[THIRD], 'привет');

      expect(created).toMatchObject({ requester_id: ids[LIVE], target_id: ids[THIRD], status: 'pending' });
      expect(await fromLiveTo(THIRD)).toEqual([{ id: created.id, status: 'pending' }]);
    });
  });
});
