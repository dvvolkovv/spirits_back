import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DELETION_DISCOVERERS } from '../account-deletion/account-deletion.catalog';
import {
  DeletionCancelledError,
  safeDeletionJobSnapshot,
} from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
} from '../account-deletion/account-deletion.types';
import { DevicesAccountDeletionAdapter } from '../devices/devices-account-deletion.adapter';
import { LegacyAuthAccountDeletionAdapter } from '../identity/legacy-auth-account-deletion.adapter';
import { BackupModule } from './backup.module';
import {
  discoverBackupDeletion,
  BackupAccountDeletionAdapter,
} from './backup-account-deletion.adapter';

/**
 * Task 17D — profile_backups: слепое зашифрованное хранилище копии профиля
 * (A6 §4.2.1). Одна строка на пользователя (user_id TEXT PK, blob + prev_blob)
 * — purge удаляет её по user_id под generation predicate. Шифротекст не
 * поднимается в план (payload {}) и не попадает в журнал параметров после
 * удаления.
 *
 * Платёжный ledger (token_transactions) НЕ трогается: финансовые записи
 * переживают удаление аккаунта (canary-тест из плана — backups/devices/
 * short_codes удалены, token ledger остаётся).
 */

const USER = 'u-deleted';
const OTHER = 'u-other';
const deletionId = '5c4b3a29-1d0e-4f6a-8b7c-9d0e1f2a3b4c';
const account: DeletionAccount = {
  userId: USER,
  deletionId,
  deletedAt: new Date('2026-11-01T00:00:00.000Z'),
};

/**
 * Фейковая БД: повторяет SQL-семантику адаптеров 17D (generation gate,
 * DELETE по user_id/phone под EXISTS-predicate). Неизвестный запрос — throw.
 */
class FakeBackupDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  profileBackups: Array<{ user_id: string; blob: string }> = [];
  userDevices: Array<{ user_id: string; signature: string }> = [];
  shortCodes: Array<{ phone: string; short_code: string }> = [];
  tokenTransactions: Array<{ id: number; user_id: string; amount: number }> = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  /** Отказ DELETE FROM profile_backups — проверка обёртки DeletionRetryError. */
  failDelete = false;

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    if (s.startsWith('SELECT 1 FROM user_id') && s.includes(`'deleted'`)) {
      const [userId, genId] = params as [string, string];
      const ok = this.isCurrentDeletion(String(userId), String(genId));
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM profile_backups WHERE user_id')) {
      if (this.failDelete) {
        // SQLSTATE 08006 (connection_failure) → deletionErrorKind = 'db'.
        throw Object.assign(new Error('connection terminated'), { code: '08006' });
      }
      const [userId, genId] = params as [string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      const before = this.profileBackups.length;
      this.profileBackups = this.profileBackups.filter((row) => row.user_id !== String(userId));
      return { rows: [], rowCount: before - this.profileBackups.length };
    }
    if (s.startsWith('DELETE FROM user_devices WHERE user_id')) {
      const [userId, genId] = params as [string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      const before = this.userDevices.length;
      this.userDevices = this.userDevices.filter((row) => row.user_id !== String(userId));
      return { rows: [], rowCount: before - this.userDevices.length };
    }
    if (s.startsWith('DELETE FROM short_codes WHERE phone')) {
      const [userId, genId] = params as [string, string];
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      const before = this.shortCodes.length;
      this.shortCodes = this.shortCodes.filter((row) => row.phone !== String(userId));
      return { rows: [], rowCount: before - this.shortCodes.length };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  isCurrentDeletion(userId: string, genId: string): boolean {
    const u = this.users.get(userId);
    return u?.state === 'deleted' && u.deletionId === genId;
  }

  seedDefault() {
    this.users.set(USER, { state: 'deleted', deletionId });
    this.profileBackups.push({ user_id: USER, blob: 'CIPHERTEXT-CANARY' });
    this.userDevices.push(
      { user_id: USER, signature: 'desktop|macos|chrome|120' },
      { user_id: USER, signature: 'mobile|ios|safari|18' },
    );
    this.shortCodes.push({ phone: USER, short_code: '111111' });
    // Платёжный ledger сохраняется (RED из плана: toHaveLength(1)).
    this.tokenTransactions.push({ id: 1, user_id: USER, amount: 50000 });
  }
}

class FakeRedis {
  readonly deletedPrefixes: string[] = [];
  async deleteByPrefix(prefix: string): Promise<number> {
    this.deletedPrefixes.push(prefix);
    return 0;
  }
}

function makeHarness() {
  const db = new FakeBackupDb();
  db.seedDefault();
  const redis = new FakeRedis();
  const registry = new AccountDeletionRegistry();
  const adapter = new BackupAccountDeletionAdapter(registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, redis, registry, adapter, ctx };
}

function makeJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-backup-1',
    deletionId,
    userId: USER,
    resourceType: 'profile-backup.purge',
    resourceKey: 'backup',
    phase: 'purge',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-14T00:00:00Z'),
    leaseUntil: new Date('2026-12-14T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

const backupJob = () => makeJob();
const devicesJob = () => makeJob({
  id: 'job-devices-1',
  resourceType: 'devices.purge',
  resourceKey: 'devices',
});
const shortCodeJob = () => makeJob({
  id: 'job-legacy-2',
  resourceType: 'legacy-auth.purge',
  resourceKey: 'legacy-auth',
});

describe('discoverBackupDeletion — один пустой job на аккаунт (Task 17D)', () => {
  it('payload {}, resourceKey без userId; sanitizer плана проходит', async () => {
    const { db } = makeHarness();

    const plan = await discoverBackupDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([{
      resourceType: 'profile-backup.purge',
      resourceKey: 'backup',
      phase: 'purge',
      payload: {},
    }]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain('CIPHERTEXT-CANARY');
    expect(() => safeDeletionJobSnapshot(plan.jobs[0], USER)).not.toThrow();
    // Discovery НЕ читает profile_backups — только generation gate (blob в
    // план не поднимается).
    expect(db.queries).toHaveLength(1);
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverBackupDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('BackupAccountDeletionAdapter.execute (Task 17D)', () => {
  it('backups/devices/short_codes удаляются, платёжный token ledger остаётся', async () => {
    const { db, redis, adapter, ctx, registry } = makeHarness();
    const devicesAdapter = new DevicesAccountDeletionAdapter(registry);
    const legacyAuthAdapter = new LegacyAuthAccountDeletionAdapter(redis as any, registry);

    await adapter.execute(backupJob(), ctx);
    await devicesAdapter.execute(devicesJob(), ctx);
    await legacyAuthAdapter.execute(shortCodeJob(), ctx);

    expect(db.profileBackups).toHaveLength(0);
    expect(db.userDevices).toHaveLength(0);
    expect(db.shortCodes).toHaveLength(0);
    expect(db.tokenTransactions).toHaveLength(1);
    // Ledger в SQL адаптеров 17D не встречается.
    expect(JSON.stringify(db.queries)).not.toContain('token_transactions');
  });

  it('удаляет backup только своего user_id; чужой и blob-содержимое не в журнале', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.users.set(OTHER, { state: 'active', deletionId: null });
    db.profileBackups.push({ user_id: OTHER, blob: 'other-ciphertext' });

    await adapter.execute(backupJob(), ctx);

    expect(db.profileBackups).toEqual([{ user_id: OTHER, blob: 'other-ciphertext' }]);
    const del = db.queries.find((q) => q.sql.startsWith('DELETE FROM profile_backups'));
    expect(del?.params).toEqual([USER, deletionId]);
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'profile-backup.purge' }),
    );
  });

  it('generation mismatch — DELETE матчит 0 строк, backup цел', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.users.set(USER, { state: 'deleted', deletionId: 'other-generation' });

    await expect(adapter.execute(backupJob(), ctx)).resolves.toBeUndefined();
    expect(db.profileBackups).toHaveLength(1);
  });

  it('reactivation между discovery и execute — DeletionCancelledError, записи нет', async () => {
    const { db, adapter, ctx } = makeHarness();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(backupJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.queries).toHaveLength(0);
    expect(db.profileBackups).toHaveLength(1);
  });

  it('сбой БД — DeletionRetryError(kind db), backup цел', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.failDelete = true;

    await expect(adapter.execute(backupJob(), ctx)).rejects.toMatchObject({ kind: 'db' });
    expect(db.profileBackups).toHaveLength(1);
  });

  it('идемпотентность: повторный execute — тихий успех, состояние то же', async () => {
    const { db, adapter, ctx } = makeHarness();

    await adapter.execute(backupJob(), ctx);
    await expect(adapter.execute(backupJob(), ctx)).resolves.toBeUndefined();
    expect(db.profileBackups).toHaveLength(0);
  });

  it('чужой resourceType — отказ до любых операций', async () => {
    const { db, adapter, ctx } = makeHarness();

    await expect(
      adapter.execute(makeJob({ resourceType: 'avatar.purge' }), ctx),
    ).rejects.toThrow('unsupported_deletion_resource');
    expect(db.queries).toHaveLength(0);
    expect(ctx.assertCurrent).not.toHaveBeenCalled();
  });
});

describe('wiring backup (Task 17D)', () => {
  it('adapter регистрирует profile-backup.purge, BackupModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new BackupAccountDeletionAdapter(registry);
    expect(adapter.resourceTypes).toEqual(['profile-backup.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, BackupModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BackupModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === BackupAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverBackupDeletion ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverBackupDeletion),
    ).toHaveLength(1);
  });
});
