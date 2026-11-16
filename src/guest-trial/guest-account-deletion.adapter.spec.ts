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
import { LegacyAuthAccountDeletionAdapter } from '../identity/legacy-auth-account-deletion.adapter';
import { hashClaimer } from './guest-token';
import { GuestTrialModule } from './guest-trial.module';
import {
  discoverGuestDeletion,
  GuestAccountDeletionAdapter,
} from './guest-account-deletion.adapter';

/**
 * Task 17D — guest: claimed-проба и carry-приписки удалённого аккаунта.
 *
 * guest-carry.stop (immediate) стирает Redis-приписки `guest-carry:<userId>:*`
 * (guest-carry.ts) — account-addressable внешний ключ, поэтому поколение
 * перепроверяется assertCurrent до и после. guest.purge (после retention)
 * удаляет claimed-сессии guest_trial_sessions по claimed_by_hash =
 * hashClaimer(userId), вычисленному В EXECUTE (payload пустой); сообщения
 * исчезают FK-каскадом (001_guest_trial.sql ON DELETE CASCADE).
 *
 * Unclaimed-сессии (claimed_by_hash IS NULL) не затрагиваются НИКОГДА: это
 * пробы других устройств, ещё не связанные с аккаунтом (их убирает свой cron
 * по TTL). Глобальная guest_trial_settings не выбирается; suppression
 * (retention_email_unsubscribes) переживает удаление (запинено в 17C);
 * magic-link 'ml-' ключи и SMS/security rate-limits остаются до естественного
 * TTL — они не адресуемы по аккаунту и относятся к безопасности.
 */

const USER = 'u-deleted';
const CLAIMED_SESSION = 'aaaaaaaa-0000-0000-0000-000000000001';
const UNCLAIMED_SESSION = 'aaaaaaaa-0000-0000-0000-000000000002';
const deletionId = '5c4b3a29-1d0e-4f6a-8b7c-9d0e1f2a3b4c';
const account: DeletionAccount = {
  userId: USER,
  deletionId,
  deletedAt: new Date('2026-11-01T00:00:00.000Z'),
};

interface GuestSessionRow {
  id: string;
  claimed_by_hash: string | null;
}

/**
 * Фейковая БД: повторяет SQL-семантику адаптера (generation gate, DELETE под
 * EXISTS-predicate, FK-каскад сообщений). Неизвестный запрос — throw.
 */
class FakeGuestDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  guestSessions: GuestSessionRow[] = [];
  guestMessages: Array<{ session_id: string; content: string }> = [];
  guestSettings: Array<{ key: string; value: unknown }> = [];
  unsubscribes: Array<{ email: string }> = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  /** Отказ DELETE — проверка обёртки DeletionRetryError. */
  failDelete = false;

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    // Generation gate адаптера: state='deleted' + точное поколение.
    if (s.startsWith('SELECT 1 FROM user_id') && s.includes(`'deleted'`)) {
      const [userId, genId] = params as [string, string];
      const ok = this.isCurrentDeletion(String(userId), String(genId));
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM guest_trial_sessions WHERE claimed_by_hash')) {
      if (this.failDelete) {
        // SQLSTATE 08006 (connection_failure) → deletionErrorKind = 'db'.
        throw Object.assign(new Error('connection terminated'), { code: '08006' });
      }
      const [hash, userId, genId] = params as [string, string, string];
      // EXISTS-гейт: поколение не совпало → 0 строк (идемпотентный успех).
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      const before = this.guestSessions.length;
      const doomed = this.guestSessions
        .filter((row) => row.claimed_by_hash === String(hash))
        .map((row) => row.id);
      // claimed_by_hash=NULL никогда не матчит $1 — unclaimed не затрагиваются.
      this.guestSessions = this.guestSessions.filter(
        (row) => row.claimed_by_hash !== String(hash),
      );
      // FK ON DELETE CASCADE (001_guest_trial.sql): сообщения уходят с сессией.
      this.guestMessages = this.guestMessages.filter(
        (row) => !doomed.includes(row.session_id),
      );
      return { rows: [], rowCount: before - this.guestSessions.length };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  isCurrentDeletion(userId: string, genId: string): boolean {
    const u = this.users.get(userId);
    return u?.state === 'deleted' && u.deletionId === genId;
  }

  seedDefault() {
    this.users.set(USER, { state: 'deleted', deletionId });
    this.guestSessions.push(
      { id: CLAIMED_SESSION, claimed_by_hash: hashClaimer(USER) },
      { id: UNCLAIMED_SESSION, claimed_by_hash: null },
    );
    this.guestMessages.push(
      { session_id: CLAIMED_SESSION, content: 'проба удалённого' },
      { session_id: UNCLAIMED_SESSION, content: 'чужая проба' },
    );
    // Глобальные настройки пробы — не данные аккаунта.
    this.guestSettings.push(
      { key: 'mode', value: { mode: 'on' } },
      { key: 'limits', value: { daily: 150 } },
    );
    // Suppression-лист (17C): переживает удаление аккаунта.
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
  const db = new FakeGuestDb();
  db.seedDefault();
  const redis = new FakeRedis();
  const registry = new AccountDeletionRegistry();
  const adapter = new GuestAccountDeletionAdapter(redis as any, registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, redis, registry, adapter, ctx };
}

function makeJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-guest-1',
    deletionId,
    userId: USER,
    resourceType: 'guest-carry.stop',
    resourceKey: 'guest',
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

const guestStopJob = () => makeJob();
const guestPurgeJob = () => makeJob({
  id: 'job-guest-2',
  resourceType: 'guest.purge',
  phase: 'purge',
});
const verificationStopJob = () => makeJob({
  id: 'job-legacy-1',
  resourceType: 'auth-verification.stop',
  resourceKey: 'legacy-auth',
});

describe('discoverGuestDeletion — два пустых job на аккаунт (Task 17D)', () => {
  it('payload {}, статические ключи без userId; sanitizer плана проходит', async () => {
    const { db } = makeHarness();

    const plan = await discoverGuestDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toEqual([
      {
        resourceType: 'guest-carry.stop',
        resourceKey: 'guest',
        phase: 'immediate',
        payload: {},
      },
      {
        resourceType: 'guest.purge',
        resourceKey: 'guest',
        phase: 'purge',
        payload: {},
      },
    ]);
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(hashClaimer(USER));
    expect(json).not.toContain('guest-carry:');
    for (const job of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    }
    // Discovery НЕ читает guest_trial_* — только generation gate.
    expect(db.queries).toHaveLength(1);
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverGuestDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('GuestAccountDeletionAdapter.execute (Task 17D)', () => {
  it('purge удаляет только claimed session и account-addressable carry/verification keys', async () => {
    const { db, redis, adapter, ctx, registry } = makeHarness();
    const legacyAuthAdapter = new LegacyAuthAccountDeletionAdapter(redis as any, registry);
    const beforeSettings = JSON.parse(JSON.stringify(db.guestSettings));
    const beforeSuppressions = JSON.parse(JSON.stringify(db.unsubscribes));
    const unclaimedSession: GuestSessionRow = { id: UNCLAIMED_SESSION, claimed_by_hash: null };

    await adapter.execute(guestStopJob(), ctx);
    await legacyAuthAdapter.execute(verificationStopJob(), ctx);
    await adapter.execute(guestPurgeJob(), ctx);

    expect(redis.deletedPrefixes).toEqual(['guest-carry:u-deleted:', 'ev-sent-u-deleted-']);
    expect(db.guestSessions).toEqual([unclaimedSession]);
    expect(db.guestSettings).toEqual(beforeSettings);
    expect(db.unsubscribes).toEqual(beforeSuppressions);
    // FK-каскад: сообщения claimed-сессии ушли, чужая проба цела.
    expect(db.guestMessages).toEqual([
      { session_id: UNCLAIMED_SESSION, content: 'чужая проба' },
    ]);
    // Глобальные таблицы пробы и suppression в SQL не встречались.
    const sql = JSON.stringify(db.queries);
    expect(sql).not.toContain('guest_trial_settings');
    expect(sql).not.toContain('retention_email_unsubscribes');
  });

  it('guest-carry.stop стирает префикс Redis без SQL; ml-/sms-ключи не трогает', async () => {
    const { db, redis, adapter, ctx } = makeHarness();

    await adapter.execute(guestStopJob(), ctx);

    expect(redis.deletedPrefixes).toEqual(['guest-carry:u-deleted:']);
    expect(redis.deletedPrefixes.some((p) => p.startsWith('ml-'))).toBe(false);
    expect(redis.deletedPrefixes.some((p) => p.startsWith('sms'))).toBe(false);
    expect(db.queries).toHaveLength(0);
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'guest-carry.stop' }),
    );
    // Redis — внешняя операция: поколение перепроверяется до и после (2 вызова).
    expect(ctx.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it('guest.purge вычисляет claimed_by_hash в execute; payload пустой', async () => {
    const { db, adapter, ctx } = makeHarness();

    await adapter.execute(guestPurgeJob(), ctx);

    const del = db.queries.find((q) => q.sql.startsWith('DELETE FROM guest_trial_sessions'));
    expect(del?.params).toEqual([hashClaimer(USER), USER, deletionId]);
    expect(guestPurgeJob().payload).toEqual({});
    expect(JSON.stringify(guestPurgeJob().payload)).not.toContain(hashClaimer(USER));
    expect(db.guestSessions).toEqual([
      { id: UNCLAIMED_SESSION, claimed_by_hash: null },
    ]);
  });

  it('сбой Redis — DeletionRetryError(kind timeout), префикс не удалён', async () => {
    const { redis, adapter, ctx } = makeHarness();
    redis.failNext = true;

    await expect(adapter.execute(guestStopJob(), ctx)).rejects.toMatchObject({ kind: 'timeout' });
    expect(redis.deletedPrefixes).toHaveLength(0);
  });

  it('generation mismatch — DELETE матчит 0 строк, сессии целы', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.users.set(USER, { state: 'deleted', deletionId: 'other-generation' });

    await expect(adapter.execute(guestPurgeJob(), ctx)).resolves.toBeUndefined();
    expect(db.guestSessions).toHaveLength(2);
  });

  it('reactivation между discovery и execute — DeletionCancelledError, записей нет', async () => {
    const { db, redis, adapter, ctx } = makeHarness();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());

    await expect(adapter.execute(guestStopJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    await expect(adapter.execute(guestPurgeJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(redis.deletedPrefixes).toHaveLength(0);
    expect(db.queries).toHaveLength(0);
    expect(db.guestSessions).toHaveLength(2);
  });

  it('сбой БД — DeletionRetryError(kind db), данные целы', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.failDelete = true;

    await expect(adapter.execute(guestPurgeJob(), ctx)).rejects.toMatchObject({ kind: 'db' });
    expect(db.guestSessions).toHaveLength(2);
  });

  it('идемпотентность: повторный execute — тихий успех, состояние то же', async () => {
    const { db, redis, adapter, ctx } = makeHarness();

    await adapter.execute(guestStopJob(), ctx);
    await adapter.execute(guestPurgeJob(), ctx);
    await expect(adapter.execute(guestStopJob(), ctx)).resolves.toBeUndefined();
    await expect(adapter.execute(guestPurgeJob(), ctx)).resolves.toBeUndefined();
    expect(redis.deletedPrefixes).toEqual(['guest-carry:u-deleted:', 'guest-carry:u-deleted:']);
    expect(db.guestSessions).toEqual([
      { id: UNCLAIMED_SESSION, claimed_by_hash: null },
    ]);
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

describe('wiring guest (Task 17D)', () => {
  it('adapter регистрирует оба типа, GuestTrialModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new GuestAccountDeletionAdapter(new FakeRedis() as any, registry);
    expect(adapter.resourceTypes).toEqual(['guest-carry.stop', 'guest.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, GuestTrialModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, GuestTrialModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === GuestAccountDeletionAdapter)).toHaveLength(1);
    // RedisService объявлен классом (не интерфейсом) — иначе DI молча даст undefined.
    const deps = Reflect.getMetadata('design:paramtypes', GuestAccountDeletionAdapter);
    expect(Array.isArray(deps)).toBe(true);
    expect(deps).toContain(RedisService);
  });

  it('catalog содержит discoverGuestDeletion ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverGuestDeletion),
    ).toHaveLength(1);
  });
});
