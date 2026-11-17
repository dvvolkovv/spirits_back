import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import type {
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { coreTableDdl } from '../base/core-schema-ddl.forspec';
import {
  discoverGuestDeletion,
  GuestAccountDeletionAdapter,
} from './guest-account-deletion.adapter';
import { hashClaimer, hashGuestToken, newGuestToken } from './guest-token';
import { GUEST_TRIAL_MIGRATIONS } from './guest-trial-store.service';

/**
 * T17D-M2 — SQL задачи 17D (guest-trial) против живой PostgreSQL: generation
 * gate discovery и DELETE FROM guest_trial_sessions по claimed_by_hash под
 * generation predicate.
 *
 * Схема — настоящая миграция 001_guest_trial.sql (GUEST_TRIAL_MIGRATIONS):
 * фейк лишь имитирует FK ON DELETE CASCADE guest_trial_messages, здесь его
 * исполняет PostgreSQL. user_id — из снимка 001_core_schema.sql
 * (core-schema-ddl.forspec.ts) + миграция account-deletion. Своя схема на
 * спеку.
 *
 * Email/OAuth-аккаунт: internal_id — uuid (36 символов, user_id.internal_id —
 * character varying без длины). Gate по uuid обязан находить строку, а DELETE —
 * снимать claimed-сессию такого аккаунта без ошибок типов.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `guest_acct_del_spec_${process.pid}`;
const ACCOUNT_DELETION_MIGRATION = path.join(
  __dirname, '..', 'account-deletion', 'migrations', '001_account_deletion.sql',
);

const PHONE_USER = '79990000621';
const LIVE_USER = '79990000622';
const EMAIL_USER = 'c3d9a1e2-7b4f-4c5a-8e6d-2f1b0a9c8d7e';
const PHONE_DELETION = '4d3c2b1a-0f9e-4d8c-b7a6-958473625140';
const EMAIL_DELETION = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b';
const STALE_DELETION = '7a6b5c4d-3e2f-4109-a8b7-c6d5e4f3a2b1';
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const CANARY = 'ВОПРОС-ИЗ-ПРОБЫ';

function purgeJob(userId: string, deletionId: string): DeletionJobRow {
  return {
    id: `job-guest-${userId}`,
    deletionId,
    userId,
    resourceType: 'guest.purge',
    resourceKey: 'guest',
    phase: 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-01T00:00:00Z'),
    leaseUntil: new Date('2026-12-01T01:00:00Z'),
    lastErrorKind: null,
  };
}

maybe('guest-trial deletion SQL against PostgreSQL (T17D-M2)', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  let adapter: GuestAccountDeletionAdapter;
  const db = { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) };

  function makeCtx(): DeletionExecution & { assertCurrent: jest.Mock } {
    return { db, assertCurrent: jest.fn(async () => undefined) };
  }

  /** Сессия с двумя сообщениями; owner=null — unclaimed проба другого устройства. */
  async function seedSession(owner: string | null, label: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO guest_trial_sessions
         (token_hash, assistant_id, lang, answers, claimed_by_hash, claimed_at)
       VALUES ($1, 12, 'ru', 1, $2, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [hashGuestToken(newGuestToken()), owner === null ? null : hashClaimer(owner)],
    );
    const id = r.rows[0].id;
    await pool.query(
      `INSERT INTO guest_trial_messages (session_id, sender_type, content)
       VALUES ($1,'human',$2), ($1,'ai',$3)`,
      [id, `${CANARY} ${label}`, `ответ ${label}`],
    );
    return id;
  }

  async function state(): Promise<{ sessions: any[]; messages: any[]; settings: any[] }> {
    return {
      sessions: (await pool.query(
        `SELECT id, claimed_by_hash FROM guest_trial_sessions ORDER BY id`,
      )).rows,
      messages: (await pool.query(
        `SELECT session_id, sender_type, content FROM guest_trial_messages ORDER BY session_id, id`,
      )).rows,
      settings: (await pool.query(`SELECT key, value FROM guest_trial_settings ORDER BY key`)).rows,
    };
  }

  let ids: Record<string, string>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });
    for (const file of GUEST_TRIAL_MIGRATIONS) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf8'));
    }
    await pool.query(coreTableDdl(['user_id']));
    await pool.query(fs.readFileSync(ACCOUNT_DELETION_MIGRATION, 'utf8'));
    // Redis нужен только guest-carry.stop; purge — чистый SQL.
    adapter = new GuestAccountDeletionAdapter({} as any, new AccountDeletionRegistry());
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE guest_trial_sessions CASCADE`);
    await pool.query(`TRUNCATE guest_trial_settings, user_id`);
    await pool.query(
      `INSERT INTO user_id (internal_id, state, deleted_at, deletion_id) VALUES
         ($1, 'deleted', $4, $5),
         ($2, 'active', NULL, NULL),
         ($3, 'deleted', $4, $6)`,
      [PHONE_USER, LIVE_USER, EMAIL_USER, DELETED_AT, PHONE_DELETION, EMAIL_DELETION],
    );
    await pool.query(
      `INSERT INTO guest_trial_settings (key, value) VALUES ('mode', '"on"'::jsonb)`,
    );
    ids = {
      phone1: await seedSession(PHONE_USER, 'phone-1'),
      phone2: await seedSession(PHONE_USER, 'phone-2'),
      email: await seedSession(EMAIL_USER, 'email'),
      live: await seedSession(LIVE_USER, 'live'),
      unclaimed: await seedSession(null, 'unclaimed'),
    };
  });

  it('discovery: gate находит поколение и по телефону, и по uuid email-аккаунта', async () => {
    const jobs = [
      { resourceType: 'guest-carry.stop', resourceKey: 'guest', phase: 'immediate', payload: {} },
      { resourceType: 'guest.purge', resourceKey: 'guest', phase: 'purge', payload: {} },
    ];
    for (const [userId, deletionId] of [[PHONE_USER, PHONE_DELETION], [EMAIL_USER, EMAIL_DELETION]]) {
      await expect(discoverGuestDeletion({
        db, account: { userId, deletionId, deletedAt: DELETED_AT }, origin: 'explicit',
      })).resolves.toEqual({ jobs, skips: [] });
    }
    await expect(discoverGuestDeletion({
      db, account: { userId: PHONE_USER, deletionId: STALE_DELETION, deletedAt: DELETED_AT }, origin: 'explicit',
    })).resolves.toEqual({ jobs: [], skips: [] });
  });

  it('purge телефонного аккаунта: его сессии ушли, сообщения — каскадом, чужие и unclaimed целы', async () => {
    const before = await state();
    const ctx = makeCtx();

    await adapter.execute(purgeJob(PHONE_USER, PHONE_DELETION), ctx);

    const after = await state();
    const gone = [ids.phone1, ids.phone2];
    expect(after.sessions.map((s) => s.id).sort()).toEqual(
      [ids.email, ids.live, ids.unclaimed].sort(),
    );
    // FK ON DELETE CASCADE: ни одного сообщения удалённых сессий не осталось.
    expect(after.messages.filter((m) => gone.includes(m.session_id))).toEqual([]);
    // Сообщения и сессии остальных — без изменений, настройки пробы не тронуты.
    expect(after.messages).toEqual(before.messages.filter((m) => !gone.includes(m.session_id)));
    expect(after.sessions).toEqual(before.sessions.filter((s) => !gone.includes(s.id)));
    expect(after.settings).toEqual([{ key: 'mode', value: 'on' }]);
    expect(after.messages).toHaveLength(6);
    expect(ctx.assertCurrent).toHaveBeenCalledTimes(1);
  });

  it('email-аккаунт (internal_id = uuid): gate находит строку, сессия и сообщения сняты', async () => {
    const before = await state();

    await expect(
      adapter.execute(purgeJob(EMAIL_USER, EMAIL_DELETION), makeCtx()),
    ).resolves.toBeUndefined();

    const after = await state();
    expect(after.sessions.map((s) => s.id)).not.toContain(ids.email);
    expect(after.sessions).toHaveLength(before.sessions.length - 1);
    expect(after.messages.filter((m) => m.session_id === ids.email)).toEqual([]);
    expect(after.messages).toHaveLength(before.messages.length - 2);
  });

  it('идемпотентность: повторный purge — тихий успех, состояние то же', async () => {
    await adapter.execute(purgeJob(PHONE_USER, PHONE_DELETION), makeCtx());
    const first = await state();

    await expect(
      adapter.execute(purgeJob(PHONE_USER, PHONE_DELETION), makeCtx()),
    ).resolves.toBeUndefined();

    expect(await state()).toEqual(first);
  });

  it('чужое поколение и реактивация — DELETE матчит 0 строк', async () => {
    const before = await state();

    await adapter.execute(purgeJob(PHONE_USER, STALE_DELETION), makeCtx());
    await pool.query(`UPDATE user_id SET state='active' WHERE internal_id=$1`, [PHONE_USER]);
    await adapter.execute(purgeJob(PHONE_USER, PHONE_DELETION), makeCtx());

    expect(await state()).toEqual(before);
  });

  it('A6: хеш уже обнулён уборкой — DELETE матчит 0 строк, обезличенная сессия остаётся', async () => {
    await pool.query(
      `UPDATE guest_trial_sessions SET claimed_by_hash = NULL WHERE id = $1`,
      [ids.phone1],
    );
    const before = await state();

    await adapter.execute(purgeJob(PHONE_USER, PHONE_DELETION), makeCtx());

    const after = await state();
    expect(after.sessions.map((s) => s.id)).toContain(ids.phone1);
    expect(after.sessions.map((s) => s.id)).not.toContain(ids.phone2);
    expect(after.messages.filter((m) => m.session_id === ids.phone1))
      .toEqual(before.messages.filter((m) => m.session_id === ids.phone1));
  });
});
