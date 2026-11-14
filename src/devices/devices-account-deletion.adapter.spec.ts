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
import { DevicesModule } from './devices.module';
import {
  discoverDevicesDeletion,
  DevicesAccountDeletionAdapter,
} from './devices-account-deletion.adapter';

/**
 * Task 17D — user_devices: отпечатки устройств удалённого аккаунта.
 *
 * Несколько строк на пользователя (PK user_id+signature, 001_user_devices.sql)
 * — purge удаляет все по user_id под generation predicate. Сырые User-Agent
 * (raw_user_agent) в план не поднимаются (payload {}); чужие устройства
 * сохраняются (canary).
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
 * Фейковая БД: повторяет SQL-семантику адаптера (generation gate, DELETE по
 * user_id под EXISTS-predicate). Неизвестный запрос — throw.
 */
class FakeDevicesDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  userDevices: Array<{ user_id: string; signature: string; raw_user_agent?: string }> = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  /** Отказ DELETE — проверка обёртки DeletionRetryError. */
  failDelete = false;

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    if (s.startsWith('SELECT 1 FROM user_id') && s.includes(`'deleted'`)) {
      const [userId, genId] = params as [string, string];
      const ok = this.isCurrentDeletion(String(userId), String(genId));
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM user_devices WHERE user_id')) {
      if (this.failDelete) {
        // SQLSTATE 08006 (connection_failure) → deletionErrorKind = 'db'.
        throw Object.assign(new Error('connection terminated'), { code: '08006' });
      }
      const [userId, genId] = params as [string, string];
      // EXISTS-гейт: поколение не совпало → 0 строк (идемпотентный успех).
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      const before = this.userDevices.length;
      this.userDevices = this.userDevices.filter((row) => row.user_id !== String(userId));
      return { rows: [], rowCount: before - this.userDevices.length };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  isCurrentDeletion(userId: string, genId: string): boolean {
    const u = this.users.get(userId);
    return u?.state === 'deleted' && u.deletionId === genId;
  }

  seedDefault() {
    this.users.set(USER, { state: 'deleted', deletionId });
    this.users.set(OTHER, { state: 'active', deletionId: null });
    this.userDevices.push(
      { user_id: USER, signature: 'desktop|macos|chrome|120', raw_user_agent: 'UA-CANARY' },
      { user_id: USER, signature: 'mobile|ios|safari|18' },
      { user_id: OTHER, signature: 'desktop|windows|firefox|130' },
    );
  }
}

function makeHarness() {
  const db = new FakeDevicesDb();
  db.seedDefault();
  const registry = new AccountDeletionRegistry();
  const adapter = new DevicesAccountDeletionAdapter(registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, registry, adapter, ctx };
}

function makeJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-devices-1',
    deletionId,
    userId: USER,
    resourceType: 'devices.purge',
    resourceKey: 'devices',
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

const purgeJob = () => makeJob();

describe('discoverDevicesDeletion — один пустой job на аккаунт (Task 17D)', () => {
  it('payload {}, resourceKey без userId; sanitizer плана проходит', async () => {
    const { db } = makeHarness();

    const plan = await discoverDevicesDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([{
      resourceType: 'devices.purge',
      resourceKey: 'devices',
      phase: 'purge',
      payload: {},
    }]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain('UA-CANARY');
    expect(() => safeDeletionJobSnapshot(plan.jobs[0], USER)).not.toThrow();
    // Discovery НЕ читает user_devices — только generation gate.
    expect(db.queries).toHaveLength(1);
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverDevicesDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('DevicesAccountDeletionAdapter.execute (Task 17D)', () => {
  it('удаляет все устройства своего user_id, чужие сохраняет', async () => {
    const { db, adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob(), ctx);

    expect(db.userDevices).toEqual([
      { user_id: OTHER, signature: 'desktop|windows|firefox|130' },
    ]);
    const del = db.queries.find((q) => q.sql.startsWith('DELETE FROM user_devices'));
    expect(del?.params).toEqual([USER, deletionId]);
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'devices.purge' }),
    );
    // Сырой User-Agent не уходит ни в один SQL-параметр.
    expect(JSON.stringify(db.queries)).not.toContain('UA-CANARY');
  });

  it('generation mismatch — DELETE матчит 0 строк, устройства целы', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.users.set(USER, { state: 'deleted', deletionId: 'other-generation' });

    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(db.userDevices).toHaveLength(3);
  });

  it('reactivation между discovery и execute — DeletionCancelledError, записи нет', async () => {
    const { db, adapter, ctx } = makeHarness();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(purgeJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.queries).toHaveLength(0);
    expect(db.userDevices).toHaveLength(3);
  });

  it('сбой БД — DeletionRetryError(kind db), данные целы', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.failDelete = true;

    await expect(adapter.execute(purgeJob(), ctx)).rejects.toMatchObject({ kind: 'db' });
    expect(db.userDevices).toHaveLength(3);
  });

  it('идемпотентность: повторный execute — тихий успех, состояние то же', async () => {
    const { db, adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob(), ctx);
    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(db.userDevices).toHaveLength(1);
    expect(db.userDevices[0].user_id).toBe(OTHER);
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

describe('wiring devices (Task 17D)', () => {
  it('adapter регистрирует devices.purge, DevicesModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new DevicesAccountDeletionAdapter(registry);
    expect(adapter.resourceTypes).toEqual(['devices.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, DevicesModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DevicesModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === DevicesAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverDevicesDeletion ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverDevicesDeletion),
    ).toHaveLength(1);
  });
});
