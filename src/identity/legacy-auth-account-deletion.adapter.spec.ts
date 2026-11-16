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
import { RedisService } from '../common/services/redis.service';
import { IdentityModule } from './identity.module';
import {
  discoverLegacyAuthDeletion,
  LegacyAuthAccountDeletionAdapter,
} from './legacy-auth-account-deletion.adapter';

/**
 * Task 17D — legacy auth: verification-заслонки и легаси short_codes.
 *
 * auth-verification.stop (immediate) стирает Redis-заслонки
 * `ev-sent-<userId>-<hash16>` (email.service.ts) — «verification уже
 * предлагался»: account-addressable внешний ключ → assertCurrent до и после,
 * SQL нет. Токены верификации `ev-<token>`, magic-link `ml-*` и SMS/security
 * rate-limits НЕ трогаются: по аккаунту не адресуемы (случайные токены) и
 * относятся к безопасности — гаснут естественным TTL.
 *
 * legacy-auth.purge (после retention) удаляет строки легаси-таблицы
 * short_codes (эпоха n8n; TS-ссылок в репо нет — чистый SQL) по phone=userId
 * под generation predicate. Ловушка схемы: phone varchar(20), а userId
 * email/OAuth-аккаунтов — UUID на 36 символов: сравнение безопасно
 * (0 строк, без ошибки), колонка НЕ расширяется.
 *
 * retention_email_unsubscribes не выбирается никогда: suppression намеренно
 * переживает удаление аккаунта (запинено в 17C).
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
 * Фейковая БД: повторяет SQL-семантику адаптера (generation gate, DELETE под
 * EXISTS-predicate). Неизвестный запрос — throw.
 */
class FakeLegacyDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  shortCodes: Array<{ phone: string; short_code: string }> = [];
  unsubscribes: Array<{ email: string }> = [];
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
    if (s.startsWith('DELETE FROM short_codes WHERE phone')) {
      if (this.failDelete) {
        // SQLSTATE 08006 (connection_failure) → deletionErrorKind = 'db'.
        throw Object.assign(new Error('connection terminated'), { code: '08006' });
      }
      const [userId, genId] = params as [string, string];
      // EXISTS-гейт: поколение не совпало → 0 строк (идемпотентный успех).
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
    this.users.set(OTHER, { state: 'active', deletionId: null });
    this.shortCodes.push(
      { phone: USER, short_code: '111111' },
      { phone: OTHER, short_code: '222222' },
    );
    this.unsubscribes.push({ email: 'someone@example.com' });
  }
}

/** Фейковый Redis: журнал удалённых префиксов, отказ по флагам. */
class FakeRedis {
  readonly deletedPrefixes: string[] = [];
  failNext = false;

  async deleteByPrefix(prefix: string): Promise<number> {
    if (this.failNext) {
      this.failNext = false;
      throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    }
    this.deletedPrefixes.push(prefix);
    return 0;
  }
}

function makeHarness() {
  const db = new FakeLegacyDb();
  db.seedDefault();
  const redis = new FakeRedis();
  const registry = new AccountDeletionRegistry();
  const adapter = new LegacyAuthAccountDeletionAdapter(redis as any, registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, redis, registry, adapter, ctx };
}

function makeJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-legacy-1',
    deletionId,
    userId: USER,
    resourceType: 'auth-verification.stop',
    resourceKey: 'legacy-auth',
    phase: 'immediate',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-12-14T00:00:00Z'),
    leaseUntil: new Date('2026-12-14T01:00:00Z'),
    lastErrorKind: null,
    ...overrides,
  };
}

const stopJob = () => makeJob();
const purgeJob = (overrides: Partial<DeletionJobRow> = {}) => makeJob({
  id: 'job-legacy-2',
  resourceType: 'legacy-auth.purge',
  phase: 'purge',
  ...overrides,
});

describe('discoverLegacyAuthDeletion — два пустых job на аккаунт (Task 17D)', () => {
  it('payload {}, статические ключи без userId; sanitizer плана проходит', async () => {
    const { db } = makeHarness();

    const plan = await discoverLegacyAuthDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([
      {
        resourceType: 'auth-verification.stop',
        resourceKey: 'legacy-auth',
        phase: 'immediate',
        payload: {},
      },
      {
        resourceType: 'legacy-auth.purge',
        resourceKey: 'legacy-auth',
        phase: 'purge',
        payload: {},
      },
    ]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain('ev-sent-');
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    }
    // Discovery НЕ читает short_codes — только generation gate.
    expect(db.queries).toHaveLength(1);
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverLegacyAuthDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('LegacyAuthAccountDeletionAdapter.execute (Task 17D)', () => {
  it('auth-verification.stop стирает ev-sent-префикс без SQL; ml-/ev-токены не трогает', async () => {
    const { db, redis, adapter, ctx } = makeHarness();

    await adapter.execute(stopJob(), ctx);

    expect(redis.deletedPrefixes).toEqual(['ev-sent-u-deleted-']);
    // Magic-link и verification-токены не адресуемы по userId — остаются до TTL.
    expect(redis.deletedPrefixes.some((p) => p.startsWith('ml-'))).toBe(false);
    expect(redis.deletedPrefixes.some((p) => p === 'ev-')).toBe(false);
    expect(db.queries).toHaveLength(0);
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'auth-verification.stop' }),
    );
    // Redis — внешняя операция: поколение перепроверяется до и после (2 вызова).
    expect(ctx.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it('legacy-auth.purge удаляет свои short_codes, чужие сохраняет', async () => {
    const { db, adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob(), ctx);

    expect(db.shortCodes).toEqual([{ phone: OTHER, short_code: '222222' }]);
    const del = db.queries.find((q) => q.sql.startsWith('DELETE FROM short_codes'));
    expect(del?.params).toEqual([USER, deletionId]);
    // Suppression-лист не выбирается (17C).
    expect(JSON.stringify(db.queries)).not.toContain('retention_email_unsubscribes');
    expect(db.unsubscribes).toHaveLength(1);
  });

  it('email-аккаунт (UUID userId) — 0 строк против varchar(20), без ошибки', async () => {
    const { db, adapter, ctx } = makeHarness();
    const uuid = 'b7e1f2a3-4c5d-6e7f-8a9b-0c1d2e3f4a5b';
    db.users.set(uuid, { state: 'deleted', deletionId });

    await expect(
      adapter.execute(purgeJob({ id: 'job-legacy-uuid', userId: uuid }), ctx),
    ).resolves.toBeUndefined();
    expect(db.shortCodes).toHaveLength(2);
  });

  it('сбой Redis — DeletionRetryError(kind timeout), префикс не удалён', async () => {
    const { redis, adapter, ctx } = makeHarness();
    redis.failNext = true;

    await expect(adapter.execute(stopJob(), ctx)).rejects.toMatchObject({ kind: 'timeout' });
    expect(redis.deletedPrefixes).toHaveLength(0);
  });

  it('generation mismatch — DELETE матчит 0 строк, коды целы', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.users.set(USER, { state: 'deleted', deletionId: 'other-generation' });

    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(db.shortCodes).toHaveLength(2);
  });

  it('reactivation между discovery и execute — DeletionCancelledError, записей нет', async () => {
    const { db, redis, adapter, ctx } = makeHarness();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(stopJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    await expect(adapter.execute(purgeJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(redis.deletedPrefixes).toHaveLength(0);
    expect(db.queries).toHaveLength(0);
    expect(db.shortCodes).toHaveLength(2);
  });

  it('сбой БД — DeletionRetryError(kind db), данные целы', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.failDelete = true;

    await expect(adapter.execute(purgeJob(), ctx)).rejects.toMatchObject({ kind: 'db' });
    expect(db.shortCodes).toHaveLength(2);
  });

  it('идемпотентность: повторный execute — тихий успех, состояние то же', async () => {
    const { db, adapter, ctx } = makeHarness();

    await adapter.execute(purgeJob(), ctx);
    await expect(adapter.execute(purgeJob(), ctx)).resolves.toBeUndefined();
    expect(db.shortCodes).toEqual([{ phone: OTHER, short_code: '222222' }]);
  });

  it('чужой resourceType — отказ до любых операций', async () => {
    const { db, redis, adapter, ctx } = makeHarness();

    await expect(
      adapter.execute(makeJob({ resourceType: 'avatar.purge' }), ctx),
    ).rejects.toThrow('unsupported_deletion_resource');
    expect(db.queries).toHaveLength(0);
    expect(redis.deletedPrefixes).toHaveLength(0);
    expect(ctx.assertCurrent).not.toHaveBeenCalled();
  });
});

describe('wiring legacy-auth (Task 17D)', () => {
  it('adapter регистрирует оба типа, IdentityModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new LegacyAuthAccountDeletionAdapter(new FakeRedis() as any, registry);
    expect(adapter.resourceTypes).toEqual(['auth-verification.stop', 'legacy-auth.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, IdentityModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, IdentityModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === LegacyAuthAccountDeletionAdapter)).toHaveLength(1);
    // RedisService объявлен классом (не интерфейсом) — иначе DI молча даст undefined.
    const deps = Reflect.getMetadata('design:paramtypes', LegacyAuthAccountDeletionAdapter);
    expect(Array.isArray(deps)).toBe(true);
    expect(deps).toContain(RedisService);
  });

  it('catalog содержит discoverLegacyAuthDeletion ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverLegacyAuthDeletion),
    ).toHaveLength(1);
  });
});
