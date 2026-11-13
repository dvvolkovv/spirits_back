import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { DELETION_DISCOVERERS, DELETION_DEPENDENCIES } from '../account-deletion/account-deletion.catalog';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { safeDeletionJobSnapshot } from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { IntegrationsModule } from './integrations.module';
import {
  IntegrationAccountDeletionAdapter,
  discoverIntegrationDeletion,
} from './integration-account-deletion.adapter';

/**
 * Task 9 — OAuth/интеграции при удалении аккаунта.
 *
 * Apple: revoke refresh-токена ОБЯЗАТЕЛЕН до identity unlink (требование
 * Sign in with Apple); токены читаются только в памяти execute и не попадают
 * ни в job payload, ни в журналы. Zoom/TalerID: существующий disconnect —
 * идемпотентный hard-delete. integration_flags (глобальные выключатели) и
 * singleton short_youtube_account не выбираются и не изменяются: это ресурсы
 * платформы, а не пользователя.
 */

const APPLE_REFRESH = 'REFRESH-CANARY-APPLE';

class FakeIntegrationDb {
  appleIdentities: Array<{ user_id: string; provider: string; provider_refresh_token: string | null }> = [];
  zoomRows: Array<{ user_id: string }> = [];
  taleridRows: Array<{ user_id: string }> = [];
  /** Канарейки: эти таблицы адаптер запрашивать не имеет права. */
  integrationFlags: Array<Record<string, any>> = [{ id: 'flag-1', kind: 'zoom', enabled: true }];
  youtubeSingleton: Array<Record<string, any>> = [{ id: 1 }];
  readonly queries: Array<{ sql: string; params: any[] }> = [];

  async query(sql: string, params: any[] = []) {
    this.queries.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT 1 FROM user_identities i WHERE i.user_id=$1')) {
      const found = this.appleIdentities.some((row) => row.user_id === params[0]
        && row.provider === 'apple' && row.provider_refresh_token != null);
      return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
    }
    if (s.startsWith('SELECT 1 FROM zoom_connections z WHERE z.user_id=$1')) {
      const found = this.zoomRows.some((row) => row.user_id === params[0]);
      return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
    }
    if (s.startsWith('SELECT 1 FROM talerid_connections t WHERE t.user_id=$1')) {
      const found = this.taleridRows.some((row) => row.user_id === params[0]);
      return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
    }
    throw new Error(`unexpected query: ${s}`);
  }
}

const deletionId = 'deletion-old';
const account: DeletionAccount = {
  userId: 'u-deleted',
  deletionId,
  deletedAt: new Date('2026-11-11T00:00:00Z'),
};

function job(resourceType: DeletionResourceType, resourceKey: string): DeletionJobRow {
  return {
    id: `job-${resourceType}`,
    deletionId,
    userId: account.userId,
    resourceType,
    resourceKey,
    phase: 'immediate',
    payload: { provider: resourceKey },
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-11T00:00:00Z'),
    leaseUntil: new Date('2026-11-11T01:00:00Z'),
    lastErrorKind: null,
  };
}

function makeDeps(overrides: Partial<{
  tokens: string[];
  revokeResult: boolean;
}> = {}) {
  const identity = {
    providerRefreshTokens: jest.fn(async () => overrides.tokens ?? [APPLE_REFRESH]),
  };
  const apple = {
    revokeToken: jest.fn(async () => overrides.revokeResult ?? true),
    primaryClientId: jest.fn(() => 'com.linkeon.app'),
  };
  const zoom = { disconnect: jest.fn(async () => {}) };
  const talerid = { disconnect: jest.fn(async () => {}) };
  return { identity, apple, zoom, talerid };
}

function makeAdapter(db: FakeIntegrationDb, deps = makeDeps()) {
  const adapter = new IntegrationAccountDeletionAdapter(
    deps.identity as any,
    deps.apple as any,
    deps.zoom as any,
    deps.talerid as any,
    new AccountDeletionRegistry(),
  );
  return { adapter, ...deps };
}

function execution(db: FakeIntegrationDb): DeletionExecution & { assertCurrent: jest.Mock } {
  return { db: db as any, assertCurrent: jest.fn(async () => {}) };
}

function seedAll(db: FakeIntegrationDb) {
  db.appleIdentities.push({ user_id: account.userId, provider: 'apple', provider_refresh_token: APPLE_REFRESH });
  db.zoomRows.push({ user_id: account.userId });
  db.taleridRows.push({ user_id: account.userId });
}

describe('integration deletion discovery', () => {
  it('создаёт account-level stop-задачи только по существующим связкам, без токенов в payload', async () => {
    const db = new FakeIntegrationDb();
    seedAll(db);
    db.appleIdentities.push({ user_id: 'u-other', provider: 'apple', provider_refresh_token: 'other' });

    const plan = await discoverIntegrationDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.skips).toEqual([]);
    expect(plan.jobs.map((item) => [item.resourceType, item.resourceKey, item.phase])).toEqual([
      ['integration.apple.stop', 'apple', 'immediate'],
      ['integration.zoom.stop', 'zoom', 'immediate'],
      ['integration.talerid.stop', 'talerid', 'immediate'],
    ]);
    for (const item of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(item, account.userId)).not.toThrow();
    }
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('REFRESH-CANARY');
    expect(serialized).not.toContain(account.userId);
    // Глобальные ресурсы платформы не выбираются.
    for (const { sql } of db.queries) {
      expect(sql).not.toContain('integration_flags');
      expect(sql).not.toContain('short_youtube_account');
    }
  });

  it('без связок не создаёт задач', async () => {
    const db = new FakeIntegrationDb();
    const plan = await discoverIntegrationDeletion({ db: db as any, account, origin: 'merge' });
    expect(plan.jobs).toEqual([]);
    expect(plan.skips).toEqual([]);
  });

  it('apple-связка без refresh-токена не даёт stop-задачу', async () => {
    const db = new FakeIntegrationDb();
    db.appleIdentities.push({ user_id: account.userId, provider: 'apple', provider_refresh_token: null });
    const plan = await discoverIntegrationDeletion({ db: db as any, account, origin: 'explicit' });
    expect(plan.jobs).toEqual([]);
  });
});

describe('IntegrationAccountDeletionAdapter', () => {
  beforeEach(() => {
    account.userId = 'u-deleted';
  });

  it('apple.stop отзывает каждый токен через существующий revokeToken, токены только в памяти', async () => {
    const db = new FakeIntegrationDb();
    const { adapter, identity, apple } = makeAdapter(db);
    const ctx = execution(db);

    await adapter.execute(job('integration.apple.stop', 'apple'), ctx);

    expect(ctx.assertCurrent).toHaveBeenCalledTimes(1);
    expect(identity.providerRefreshTokens).toHaveBeenCalledWith(account.userId, 'apple');
    expect(apple.revokeToken).toHaveBeenCalledTimes(1);
    expect(apple.revokeToken).toHaveBeenCalledWith(APPLE_REFRESH, 'com.linkeon.app');
    // Токен не уходит ни в один SQL-параметр.
    for (const { params } of db.queries) {
      expect(params).not.toContain(APPLE_REFRESH);
    }
  });

  it('apple.stop: неудачный/неизвестный результат revoke → retry, таймаут тоже', async () => {
    const db = new FakeIntegrationDb();
    const failed = makeAdapter(db, makeDeps({ revokeResult: false }));
    await expect(failed.adapter.execute(job('integration.apple.stop', 'apple'), execution(db)))
      .rejects.toMatchObject({ kind: 'external_unknown' });

    const timeout = makeAdapter(db, makeDeps());
    timeout.apple.revokeToken.mockRejectedValue({ code: 'ETIMEDOUT' });
    // revokeToken в проде глотает ошибки и возвращает false; здесь — защита от
    // неожиданного проброса: kind должен остаться retry-совместимым.
    await expect(timeout.adapter.execute(job('integration.apple.stop', 'apple'), execution(db)))
      .rejects.toMatchObject({ kind: 'timeout' });
  });

  it('apple.stop идемпотентен: нет токенов (unlink уже произошёл) — успех без вызовов', async () => {
    const db = new FakeIntegrationDb();
    const { adapter, apple } = makeAdapter(db, makeDeps({ tokens: [] }));

    await expect(adapter.execute(job('integration.apple.stop', 'apple'), execution(db)))
      .resolves.toBeUndefined();
    expect(apple.revokeToken).not.toHaveBeenCalled();
  });

  it('zoom.stop и talerid.stop: 5xx → external_5xx retry, успех идемпотентен', async () => {
    const db = new FakeIntegrationDb();
    const { adapter, zoom, talerid } = makeAdapter(db);
    const ctx = execution(db);

    zoom.disconnect.mockRejectedValueOnce({ response: { status: 503 } });
    await expect(adapter.execute(job('integration.zoom.stop', 'zoom'), ctx))
      .rejects.toMatchObject({ kind: 'external_5xx' });

    await adapter.execute(job('integration.zoom.stop', 'zoom'), ctx);
    await adapter.execute(job('integration.zoom.stop', 'zoom'), ctx);
    expect(zoom.disconnect).toHaveBeenCalledTimes(3);
    expect(zoom.disconnect).toHaveBeenCalledWith(account.userId);

    talerid.disconnect.mockRejectedValueOnce({ code: 'ETIMEDOUT' });
    await expect(adapter.execute(job('integration.talerid.stop', 'talerid'), ctx))
      .rejects.toMatchObject({ kind: 'timeout' });
    await adapter.execute(job('integration.talerid.stop', 'talerid'), ctx);
    expect(talerid.disconnect).toHaveBeenCalledTimes(2);
    expect(talerid.disconnect).toHaveBeenCalledWith(account.userId);
  });

  it('apple.stop выполняется до identity unlink: unlink делает только account.core после всех stop', async () => {
    // Порядок обеспечивает существующая зависимость: account.core.purge ждёт
    // завершения ВСЕХ '*.stop' этого поколения (allStop), а интеграционные
    // задачи — стоп-фазы immediate. Сам адаптер identities не удаляет.
    expect(DELETION_DEPENDENCIES['account.core.purge']).toEqual({ allStop: true });
    const db = new FakeIntegrationDb();
    const { adapter } = makeAdapter(db);
    await adapter.execute(job('integration.apple.stop', 'apple'), execution(db));
    for (const { sql } of db.queries) {
      expect(sql).not.toMatch(/DELETE FROM user_identities/i);
    }
  });

  it('неизвестный ресурс — ошибка, а не тихий пропуск', async () => {
    const db = new FakeIntegrationDb();
    const { adapter } = makeAdapter(db);
    await expect(adapter.execute(
      job('calendar.purge' as DeletionResourceType, 'calendar'),
      execution(db),
    )).rejects.toThrow('unsupported_deletion_resource');
  });

  it('регистрируется в существующем Registry без глобального assertReady', () => {
    const db = new FakeIntegrationDb();
    const registry = new AccountDeletionRegistry();
    const ready = jest.spyOn(registry, 'assertReady');
    const deps = makeDeps();
    const adapter = new IntegrationAccountDeletionAdapter(
      deps.identity as any,
      deps.apple as any,
      deps.zoom as any,
      deps.talerid as any,
      registry,
    );

    adapter.onModuleInit();

    for (const resourceType of [
      'integration.apple.stop',
      'integration.zoom.stop',
      'integration.talerid.stop',
    ] as const) {
      expect(registry.getExecutor(resourceType)).toBe(adapter);
    }
    expect(ready).not.toHaveBeenCalled();
  });

  it('catalog и IntegrationsModule содержат обязательную wiring', () => {
    expect(DELETION_DISCOVERERS.filter((item) => item === discoverIntegrationDeletion)).toHaveLength(1);
    expect(Reflect.getMetadata('providers', IntegrationsModule)).toContain(IntegrationAccountDeletionAdapter);
    expect(Reflect.getMetadata('imports', IntegrationsModule)).toContain(AccountDeletionModule);
  });
});
