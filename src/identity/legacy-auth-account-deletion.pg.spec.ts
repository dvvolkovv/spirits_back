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
  discoverLegacyAuthDeletion,
  LegacyAuthAccountDeletionAdapter,
} from './legacy-auth-account-deletion.adapter';

/**
 * T17D-M2 — SQL задачи 17D (legacy auth) против живой PostgreSQL: generation
 * gate discovery и DELETE FROM short_codes под generation predicate.
 *
 * Схема — из настоящих источников: user_id и short_codes вынимаются из снимка
 * 001_core_schema.sql (модульной миграции у short_codes нет; эпоха n8n —
 * core-schema-ddl.forspec.ts), deleted_at/deletion_id — миграция
 * account-deletion. Своя схема на спеку.
 *
 * Ловушка, которую фейк не видит: short_codes.phone — varchar(20), а userId
 * email/OAuth-аккаунта — UUID на 36 символов. Сравнение varchar(20) с более
 * длинным параметром обязано не падать 22001 (value too long) и не усекать
 * параметр до 20 символов (иначе DELETE задел бы чужую строку с совпадающим
 * префиксом); generation gate по internal_id = uuid обязан находить строку.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `legacy_auth_del_spec_${process.pid}`;
const ACCOUNT_DELETION_MIGRATION = path.join(
  __dirname, '..', 'account-deletion', 'migrations', '001_account_deletion.sql',
);

const PHONE_USER = '79990000611';
const LIVE_USER = '79990000612';
const EMAIL_USER = 'b7e4c2a0-5d1f-4e3b-9a8c-6f0e2d4b1a37';
// Чужой «телефон», совпадающий с первыми 20 символами uuid email-аккаунта:
// усечение параметра до varchar(20) удалило бы эту строку.
const PREFIX_COLLISION = EMAIL_USER.slice(0, 20);
const PHONE_DELETION = '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d';
const EMAIL_DELETION = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const STALE_DELETION = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');

function purgeJob(userId: string, deletionId: string): DeletionJobRow {
  return {
    id: `job-legacy-auth-${userId}`,
    deletionId,
    userId,
    resourceType: 'legacy-auth.purge',
    resourceKey: 'legacy-auth',
    phase: 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-01T00:00:00Z'),
    leaseUntil: new Date('2026-12-01T01:00:00Z'),
    lastErrorKind: null,
  };
}

maybe('legacy-auth deletion SQL against PostgreSQL (T17D-M2)', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  let adapter: LegacyAuthAccountDeletionAdapter;
  const db = { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) };

  function makeCtx(): DeletionExecution & { assertCurrent: jest.Mock } {
    return { db, assertCurrent: jest.fn(async () => undefined) };
  }

  async function codes(): Promise<Array<{ phone: string; short_code: string }>> {
    return (await pool.query(`SELECT phone, short_code FROM short_codes ORDER BY phone, short_code`)).rows;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });
    await pool.query(coreTableDdl(['user_id', 'short_codes']));
    await pool.query(fs.readFileSync(ACCOUNT_DELETION_MIGRATION, 'utf8'));
    // Redis нужен только auth-verification.stop; purge — чистый SQL.
    adapter = new LegacyAuthAccountDeletionAdapter({} as any, new AccountDeletionRegistry());
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE short_codes, user_id`);
    await pool.query(
      `INSERT INTO user_id (internal_id, state, deleted_at, deletion_id) VALUES
         ($1, 'deleted', $4, $5),
         ($2, 'active', NULL, NULL),
         ($3, 'deleted', $4, $6)`,
      [PHONE_USER, LIVE_USER, EMAIL_USER, DELETED_AT, PHONE_DELETION, EMAIL_DELETION],
    );
    await pool.query(
      `INSERT INTO short_codes (phone, short_code) VALUES
         ($1,'111111'), ($1,'222222'), ($2,'333333'), ($3,'444444')`,
      [PHONE_USER, LIVE_USER, PREFIX_COLLISION],
    );
  });

  it('discovery: gate находит поколение и по телефону, и по uuid email-аккаунта', async () => {
    const jobs = [
      { resourceType: 'auth-verification.stop', resourceKey: 'legacy-auth', phase: 'immediate', payload: {} },
      { resourceType: 'legacy-auth.purge', resourceKey: 'legacy-auth', phase: 'purge', payload: {} },
    ];
    for (const [userId, deletionId] of [[PHONE_USER, PHONE_DELETION], [EMAIL_USER, EMAIL_DELETION]]) {
      await expect(discoverLegacyAuthDeletion({
        db, account: { userId, deletionId, deletedAt: DELETED_AT }, origin: 'explicit',
      })).resolves.toEqual({ jobs, skips: [] });
    }
    await expect(discoverLegacyAuthDeletion({
      db, account: { userId: PHONE_USER, deletionId: STALE_DELETION, deletedAt: DELETED_AT }, origin: 'explicit',
    })).resolves.toEqual({ jobs: [], skips: [] });
  });

  it('purge телефонного аккаунта удаляет все его short_codes, чужие строки целы', async () => {
    const ctx = makeCtx();

    await adapter.execute(purgeJob(PHONE_USER, PHONE_DELETION), ctx);

    expect(await codes()).toEqual([
      { phone: LIVE_USER, short_code: '333333' },
      { phone: PREFIX_COLLISION, short_code: '444444' },
    ].sort((a, b) => (a.phone < b.phone ? -1 : 1)));
    expect(ctx.assertCurrent).toHaveBeenCalledTimes(1);
  });

  it('email-аккаунт (uuid длиннее varchar(20)): без 22001 и без усечения — чужой префикс цел', async () => {
    expect(EMAIL_USER.length).toBeGreaterThan(20);
    const before = await codes();

    // Без ошибки (22001 стал бы DeletionRetryError и вечным retry задачи).
    await expect(
      adapter.execute(purgeJob(EMAIL_USER, EMAIL_DELETION), makeCtx()),
    ).resolves.toBeUndefined();

    // Строки email-аккаунта в short_codes быть не может (колонка короче uuid);
    // строка с совпадающим 20-символьным префиксом — чужая и остаётся.
    expect(await codes()).toEqual(before);
    // Сам statement на живой схеме: параметр-uuid сравнивается без 22001,
    // gate по internal_id = uuid находит строку поколения.
    const gate = await pool.query(
      `SELECT count(*)::int AS n FROM short_codes
        WHERE phone=$1
          AND EXISTS (SELECT 1 FROM user_id u
            WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`,
      [EMAIL_USER, EMAIL_DELETION],
    );
    expect(gate.rows).toEqual([{ n: 0 }]);
    const found = await pool.query(
      `SELECT count(*)::int AS n FROM user_id u
        WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2`,
      [EMAIL_USER, EMAIL_DELETION],
    );
    expect(found.rows).toEqual([{ n: 1 }]);
  });

  it('идемпотентность: повторный purge — тихий успех, состояние то же', async () => {
    await adapter.execute(purgeJob(PHONE_USER, PHONE_DELETION), makeCtx());
    const first = await codes();

    await expect(
      adapter.execute(purgeJob(PHONE_USER, PHONE_DELETION), makeCtx()),
    ).resolves.toBeUndefined();

    expect(await codes()).toEqual(first);
  });

  it('чужое поколение и реактивация — DELETE матчит 0 строк', async () => {
    const before = await codes();

    await adapter.execute(purgeJob(PHONE_USER, STALE_DELETION), makeCtx());
    await pool.query(`UPDATE user_id SET state='active' WHERE internal_id=$1`, [PHONE_USER]);
    await adapter.execute(purgeJob(PHONE_USER, PHONE_DELETION), makeCtx());

    expect(await codes()).toEqual(before);
  });
});
