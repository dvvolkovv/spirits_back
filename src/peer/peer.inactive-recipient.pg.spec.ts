import { NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import type { DeletionJobRow } from '../account-deletion/account-deletion.types';
import { coreTableDdl } from '../base/core-schema-ddl.forspec';
import { PeerAccountDeletionAdapter } from './peer-account-deletion.adapter';
import { PeerService } from './peer.service';

/**
 * K6b — peer.sendRequest не создаёт заявку неактивному получателю.
 *
 * Аналог дыры contacts: после peer.stop удалённого живой пользователь мог
 * отправить ему новую заявку — она висела бы pending навсегда (ответить
 * некому). Получатель обязан быть state='active' (заблокированный, нет
 * строки user_id — тоже нет); ответ — тот же, что на несуществующего
 * получателя: 404 { code: 'PROFILE_NOT_AVAILABLE' }. Гейт стоит и в самом
 * INSERT — получателя могут удалить между проверками и вставкой.
 *
 * Схема — настоящие DDL: миграция peer, user_id/ai_profiles_consolidated из
 * снимка 001_core_schema.sql (core-schema-ddl.forspec.ts), миграция
 * account-deletion. Своя схема на спеку.
 */

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `peer_inactive_recipient_spec_${process.pid}`;
const MIGRATIONS = [
  path.join(__dirname, 'migrations', '001_peer_tables.sql'),
  path.join(__dirname, '..', 'account-deletion', 'migrations', '001_account_deletion.sql'),
];

// Синтетические номера (публичный репозиторий).
const DELETED = '79990000661';
const LIVE = '79990000662';
const THIRD = '79990000663';
const BLOCKED = '79990000664';
const ORPHAN = '79990000665';
const GHOST = '79990000669';
const DELETION_ID = '6f5e4d3c-2b1a-4098-8f7e-6d5c4b3a2f10';

function peerJob(resourceType: 'peer.stop' | 'peer.purge'): DeletionJobRow {
  return {
    id: `job-${resourceType}`,
    deletionId: DELETION_ID,
    userId: DELETED,
    resourceType,
    resourceKey: 'peer',
    phase: resourceType === 'peer.stop' ? 'immediate' : 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-01T00:00:00Z'),
    leaseUntil: new Date('2026-11-01T01:00:00Z'),
    lastErrorKind: null,
  };
}

maybe('peer.sendRequest: только активный получатель (K6b, PG)', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;

  const shim = (query?: (sql: string, params?: any[]) => Promise<any>) => ({
    query: query ?? ((sql: string, params?: any[]) => pool.query(sql, params)),
    getClient: () => pool.connect(),
  });

  async function rows(sql: string, params: any[] = []): Promise<any[]> {
    return (await pool.query(sql, params)).rows;
  }

  async function seedUser(id: string, state: string | null, withUserRow = true): Promise<void> {
    if (withUserRow) {
      await pool.query(
        `INSERT INTO user_id (internal_id, primary_phone, state, deleted_at, deletion_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          id,
          id,
          state,
          state === 'deleted' ? new Date('2026-11-01T00:00:00Z') : null,
          state === 'deleted' ? DELETION_ID : null,
        ],
      );
    }
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, profile_data) VALUES ($1, '{}'::jsonb)`,
      [id],
    );
  }

  async function requestsTo(id: string): Promise<any[]> {
    return rows(
      `SELECT from_user_id, status FROM chat_requests WHERE to_user_id=$1 ORDER BY created_at`,
      [id],
    );
  }

  async function notAvailable(promise: Promise<unknown>): Promise<void> {
    const error = await promise.then(() => null, (e) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 3, options: `-c search_path=${SCHEMA}` });
    await pool.query(coreTableDdl(['user_id', 'ai_profiles_consolidated']));
    for (const file of MIGRATIONS) await pool.query(fs.readFileSync(file, 'utf8'));
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE peer_messages, peer_conversations, chat_requests, user_blocks, user_reports,
                ai_profiles_consolidated, user_id RESTART IDENTITY CASCADE`,
    );
    await seedUser(DELETED, 'deleted');
    await seedUser(LIVE, 'active');
    await seedUser(THIRD, 'active');
    await seedUser(BLOCKED, 'blocked');
    await seedUser(ORPHAN, null, false);
  });

  it('после peer.stop новая заявка удалённому не создаётся — тот же ответ, что на несуществующего', async () => {
    // Удалённый успел отправить заявку живому — stop её отзывает.
    await pool.query(
      `INSERT INTO chat_requests (from_user_id,to_user_id,intro_message) VALUES ($1,$2,'старая')`,
      [DELETED, LIVE],
    );
    const adapter = new PeerAccountDeletionAdapter(new AccountDeletionRegistry());
    await adapter.execute(peerJob('peer.stop'), {
      db: { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) },
      assertCurrent: async () => undefined,
    });
    const service = new PeerService(shim() as any);

    await notAvailable(service.sendRequest(LIVE, { toUserId: DELETED, introMessage: 'ещё раз' }));

    expect(await requestsTo(DELETED)).toEqual([]);
    // Форма ответа совпадает с несуществующим получателем.
    await notAvailable(service.sendRequest(LIVE, { toUserId: GHOST, introMessage: 'никому' }));
  });

  it.each([
    ['заблокированный', BLOCKED],
    ['без строки user_id', ORPHAN],
  ])('%s получатель — заявка не создаётся', async (_label, to) => {
    const service = new PeerService(shim() as any);

    await notAvailable(service.sendRequest(LIVE, { toUserId: to, introMessage: 'привет' }));

    expect(await requestsTo(to)).toEqual([]);
  });

  it('получателя удалили между проверками и INSERT — гейт в самом INSERT, заявки нет', async () => {
    const racing = shim(async (sql: string, params?: any[]) => {
      // «Target must exist» читается после проверки получателя.
      if (/^SELECT 1 FROM ai_profiles_consolidated WHERE user_id/.test(sql.trim())) {
        await pool.query(
          `UPDATE user_id SET state='deleted', deleted_at=now(), deletion_id=gen_random_uuid()
            WHERE internal_id=$1`,
          [THIRD],
        );
      }
      return pool.query(sql, params);
    });

    await notAvailable(new PeerService(racing as any).sendRequest(LIVE, { toUserId: THIRD, introMessage: 'привет' }));

    expect(await requestsTo(THIRD)).toEqual([]);
  });

  it('активный получатель — прежнее поведение: pending создана', async () => {
    const service = new PeerService(shim() as any);

    const created = await service.sendRequest(LIVE, { toUserId: THIRD, introMessage: 'привет' });

    expect(created).toMatchObject({ status: 'pending' });
    expect(await requestsTo(THIRD)).toEqual([{ from_user_id: LIVE, status: 'pending' }]);
  });
});
