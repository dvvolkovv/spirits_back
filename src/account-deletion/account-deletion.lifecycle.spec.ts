import { ServiceUnavailableException } from '@nestjs/common';
import { AccountDeletionLifecycle, EXPLICIT_DELETION_UNAVAILABLE } from './account-deletion.lifecycle';
import { AccountDeletionRunner } from './account-deletion.runner';
import { DeletionRetryError } from './account-deletion.safe';
import type {
  DeletionAccount,
  DeletionJobRow,
  DeletionOrigin,
  DeletionResourceType,
} from './account-deletion.types';

/**
 * Task 18 — явное DELETE: begin (поколение + план), затем immediate-стопы,
 * затем core finalize. Юнит-контур: фейки runner/registry/jobs/pg записывают
 * порядок вызовов и бросают на незнакомые вызовы, чтобы «ничего не случилось»
 * нельзя было получить молчанием.
 *
 * Порядок, зафиксированный планом:
 *   ['begin','routine.stop','telegram.stop','product.stop','calendar.stop',
 *    'voice.stop','core.immediate']
 */

const USER = 'u-deleted';
const DELETION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const DELETED_AT = new Date('2026-11-01T00:00:00.000Z');
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STOP_TYPES: DeletionResourceType[] = [
  'routine.stop',
  'telegram.stop',
  'product.stop',
  'calendar.stop',
  'voice.stop',
];

/** Метка core-задачи в журнале вызовов — как в плане ('core.immediate'). */
function callLabel(resourceType: DeletionResourceType): string {
  return resourceType === 'account.core.immediate' ? 'core.immediate' : resourceType;
}

type UserRow = {
  state: string | null;
  deletion_id: string | null;
  deleted_at: Date | null;
};

/**
 * Модель user_id ровно для begin(): SELECT ... FOR UPDATE, UPDATE ...
 * RETURNING и служебные BEGIN/COMMIT/ROLLBACK. Любой другой SQL — ошибка:
 * begin не должен ходить куда-то ещё.
 */
class BeginDb {
  private seq = 0;

  constructor(readonly user: UserRow | null) {}

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
    if (s.startsWith('SELECT state, deletion_id, deleted_at FROM user_id')) {
      return {
        rows: this.user ? [{ ...this.user }] : [],
        rowCount: this.user ? 1 : 0,
      };
    }
    if (s.startsWith("UPDATE user_id SET state = 'deleted'")) {
      if (!this.user || this.user.state !== 'active') return { rows: [], rowCount: 0 };
      const deletionId = `11111111-1111-4111-8111-${String(++this.seq).padStart(12, '0')}`;
      this.user.state = 'deleted';
      this.user.deletion_id = deletionId;
      this.user.deleted_at = new Date();
      return {
        rows: [{
          internal_id: params[0],
          deletion_id: deletionId,
          deleted_at: this.user.deleted_at,
        }],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected sql: ${s}`);
  }

  async getClient() {
    return {
      query: (sql: string, params?: any[]) => this.query(sql, params ?? []),
      release: () => undefined,
    };
  }
}

function makeStopRow(index: number, resourceType: DeletionResourceType): DeletionJobRow {
  return {
    id: `stop-${index}`,
    deletionId: DELETION_ID,
    userId: USER,
    resourceType,
    resourceKey: resourceType.split('.')[0],
    phase: 'immediate',
    payload: {},
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(),
    leaseUntil: null,
    lastErrorKind: null,
  };
}

function makeCoreRow(status: DeletionJobRow['status'] = 'pending'): DeletionJobRow {
  return {
    id: 'core',
    deletionId: DELETION_ID,
    userId: USER,
    resourceType: 'account.core.immediate',
    resourceKey: 'account',
    phase: 'immediate',
    payload: {},
    status,
    attempts: status === 'pending' ? 0 : 1,
    nextAttemptAt: new Date(),
    leaseUntil: status === 'done' ? null : new Date(),
    lastErrorKind: null,
  };
}

interface JobsFakeOptions {
  stops: DeletionJobRow[];
  core: DeletionJobRow | null;
  /** find() обязан бросить DeletionRetryError('db') — рассогласование плана и хранилища. */
  coreMissing?: boolean;
  /** claimById всегда null — например, задачу угнал конкурирующий worker. */
  claimAlwaysNull?: boolean;
}

function makeJobsFake(options: JobsFakeOptions) {
  const queue = [...options.stops];
  return {
    claimNextStop: jest.fn(async () => {
      // Как настоящий claim: только не-done строки (done не перезапускаются).
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (next.status === 'done') continue;
        next.status = 'running';
        next.attempts += 1;
        next.leaseUntil = new Date(Date.now() + 300_000);
        return next;
      }
      return null;
    }),
    claimById: jest.fn(async (id: string) => {
      if (options.claimAlwaysNull) return null;
      if (options.core && id === options.core.id
        && ['pending', 'failed'].includes(options.core.status)) {
        options.core.status = 'running';
        options.core.attempts += 1;
        options.core.leaseUntil = new Date(Date.now() + 300_000);
        return options.core;
      }
      return null;
    }),
    find: jest.fn(async (
      _deletionId: string,
      resourceType: DeletionResourceType,
      resourceKey: string,
    ) => {
      if (resourceType === 'account.core.immediate' && resourceKey === 'account') {
        if (options.coreMissing || !options.core) throw new DeletionRetryError('db');
        return options.core;
      }
      throw new Error(`unexpected find: ${resourceType}/${resourceKey}`);
    }),
    assertNoImmediateBlockers: jest.fn(async () => {
      if (options.stops.some((row) => row.status !== 'done')) {
        throw new DeletionRetryError('db');
      }
    }),
    heartbeat: jest.fn(async () => true),
    finish: jest.fn(async (job: DeletionJobRow) => {
      if (job.status !== 'running') return false;
      job.status = 'done';
      job.leaseUntil = null;
      return true;
    }),
    fail: jest.fn(async (job: DeletionJobRow, kind: string) => {
      if (job.status !== 'running') return false;
      job.status = kind === 'cancelled' ? 'cancelled' : 'failed';
      job.lastErrorKind = kind as DeletionJobRow['lastErrorKind'];
      job.leaseUntil = null;
      return true;
    }),
    assertCurrent: jest.fn(async () => undefined),
  };
}

/** Каждый метод бросает: доказываем, что путь не трогает jobs вовсе. */
function makePoisonJobs() {
  const poison = () => {
    throw new Error('unexpected jobs call');
  };
  return new Proxy({}, { get: () => poison });
}

function makeRegistryFake(calls: string[]) {
  const failures = new Map<string, unknown>();
  return {
    assertReady: jest.fn(),
    getExecutor: (resourceType: DeletionResourceType) => ({
      resourceTypes: [resourceType],
      execute: async () => {
        calls.push(callLabel(resourceType));
        const failure = failures.get(resourceType);
        if (failure) throw failure;
      },
    }),
    fail(resourceType: DeletionResourceType, error: unknown): void {
      failures.set(resourceType, error);
    },
  };
}

function makePlannerFake(calls: string[], collected: Array<{ account: DeletionAccount; origin: DeletionOrigin }>) {
  return {
    collect: jest.fn(async (
      _db: unknown,
      account: DeletionAccount,
      origin: DeletionOrigin,
    ) => {
      // collect вызывается ровно один раз — внутри begin-транзакции.
      calls.push('begin');
      collected.push({ account, origin });
      return { jobs: [], skips: [] };
    }),
    persist: jest.fn(async () => undefined),
  };
}

interface StackOptions {
  user: UserRow | null;
  stops?: Array<'pending' | 'done'>;
  core?: DeletionJobRow | null;
  coreMissing?: boolean;
  claimAlwaysNull?: boolean;
  poisonJobs?: boolean;
  registryNotReady?: boolean;
}

function makeStack(options: StackOptions) {
  const calls: string[] = [];
  const collected: Array<{ account: DeletionAccount; origin: DeletionOrigin }> = [];
  const stopRows = STOP_TYPES.map((resourceType, index) => {
    const row = makeStopRow(index, resourceType);
    const status = options.stops?.[index] ?? 'pending';
    if (status === 'done') {
      row.status = 'done';
      row.attempts = 1;
      row.leaseUntil = null;
    }
    return row;
  });
  const db = new BeginDb(options.user ? { ...options.user } : null);
  const coreRow = options.core === undefined ? makeCoreRow() : options.core;
  const jobs = options.poisonJobs
    ? makePoisonJobs()
    : makeJobsFake({
      stops: stopRows,
      core: coreRow,
      coreMissing: options.coreMissing,
      claimAlwaysNull: options.claimAlwaysNull,
    });
  const registry = makeRegistryFake(calls);
  if (options.registryNotReady) {
    registry.assertReady.mockImplementation(() => {
      throw new Error('deletion_registry_not_ready');
    });
  }
  const planner = makePlannerFake(calls, collected);
  const runner = new AccountDeletionRunner({} as any, jobs as any, registry as any);
  const lifecycle = new AccountDeletionLifecycle(
    db as any,
    planner as any,
    jobs as any,
    registry as any,
    runner,
  );
  return { lifecycle, calls, collected, stopRows, coreRow, db, jobs, registry, planner };
}

function activeUser(): UserRow {
  return { state: 'active', deletion_id: null, deleted_at: null };
}

describe('account deletion lifecycle (Task 18, unit)', () => {
  it('DELETE создаёт generation и вызывает stop до core finalize', async () => {
    const stack = makeStack({ user: activeUser() });

    await stack.lifecycle.deleteExplicit(USER);

    expect(stack.calls).toEqual([
      'begin',
      'routine.stop',
      'telegram.stop',
      'product.stop',
      'calendar.stop',
      'voice.stop',
      'core.immediate',
    ]);
    // Поколение создано: state/deletion_id/deleted_at.
    expect(stack.db.user).not.toBeNull();
    expect(stack.db.user!.state).toBe('deleted');
    expect(stack.db.user!.deletion_id).toMatch(UUID_RE);
    expect(stack.db.user!.deleted_at).not.toBeNull();
    // begin передал в planner текущее поколение и явное происхождение.
    expect(stack.collected).toHaveLength(1);
    expect(stack.collected[0].origin).toBe('explicit');
    expect(stack.collected[0].account.deletionId).toBe(stack.db.user!.deletion_id);
    // Все stop-задачи и core завершены.
    for (const row of stack.stopRows) expect(row.status).toBe('done');
  });

  it('stop failure не продолжает core и не возвращает ложный success', async () => {
    const stack = makeStack({ user: activeUser() });
    stack.registry.fail('telegram.stop', new DeletionRetryError('timeout'));

    const error = await stack.lifecycle.deleteExplicit(USER).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(EXPLICIT_DELETION_UNAVAILABLE);
    expect(error.getStatus()).toBe(503);
    // Фиксированное безопасное сообщение: без deletionId/userId.
    expect(error.message).not.toContain(USER);
    expect(error.message).not.toContain(DELETION_ID);
    // Остальные стопы дошли, core не вызывался.
    expect(stack.calls).toEqual([
      'begin',
      'routine.stop',
      'telegram.stop',
      'product.stop',
      'calendar.stop',
      'voice.stop',
    ]);
    const telegram = stack.stopRows[1];
    expect(telegram.status).toBe('failed');
    expect(telegram.lastErrorKind).toBe('timeout');
  });

  it('historical deleted без generation — ранний return без stops', async () => {
    const stack = makeStack({
      user: { state: 'deleted', deletion_id: null, deleted_at: DELETED_AT },
      poisonJobs: true,
    });

    await expect(stack.lifecycle.deleteExplicit(USER)).resolves.toBeUndefined();

    expect(stack.calls).toEqual([]);
    expect(stack.db.user).toEqual({
      state: 'deleted', deletion_id: null, deleted_at: DELETED_AT,
    });
  });

  it.each([
    ['blocked', 'blocked'],
    ['NULL', null],
  ])('state %s не трогаем — ранний return без stops', async (_label, state) => {
    const stack = makeStack({
      user: { state: state as string | null, deletion_id: null, deleted_at: null },
      poisonJobs: true,
    });

    await expect(stack.lifecycle.deleteExplicit(USER)).resolves.toBeUndefined();

    expect(stack.calls).toEqual([]);
    expect(stack.db.user!.state).toBe(state);
    expect(stack.db.user!.deletion_id).toBeNull();
  });

  it('повторный request текущего generation переиспользует deletion_id', async () => {
    const stack = makeStack({
      user: { state: 'deleted', deletion_id: DELETION_ID, deleted_at: DELETED_AT },
      stops: ['done', 'done', 'done', 'done', 'done'],
      core: makeCoreRow('done'),
    });

    await expect(stack.lifecycle.deleteExplicit(USER)).resolves.toBeUndefined();

    // Стопы и core уже done — исполнителей не трогаем, только begin.
    expect(stack.calls).toEqual(['begin']);
    expect(stack.collected[0].account).toEqual({
      userId: USER, deletionId: DELETION_ID, deletedAt: DELETED_AT,
    });
    expect(stack.db.user!.deletion_id).toBe(DELETION_ID);
  });

  it('отсутствующий пользователь — ранний return', async () => {
    const stack = makeStack({ user: null, poisonJobs: true });

    await expect(stack.lifecycle.deleteExplicit(USER)).resolves.toBeUndefined();

    expect(stack.calls).toEqual([]);
  });

  it('рассогласование плана (core-задача отсутствует) — 503, не ложный success', async () => {
    const stack = makeStack({ user: activeUser(), coreMissing: true });

    await expect(stack.lifecycle.deleteExplicit(USER))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(stack.calls).toEqual([
      'begin',
      'routine.stop',
      'telegram.stop',
      'product.stop',
      'calendar.stop',
      'voice.stop',
    ]);
  });

  it('core нельзя заклеймить (конкуренция/реактивация) — 503', async () => {
    const stack = makeStack({ user: activeUser(), claimAlwaysNull: true });

    await expect(stack.lifecycle.deleteExplicit(USER))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('провал core-адаптера не становится ложным success (контроль статуса)', async () => {
    const stack = makeStack({ user: activeUser() });
    stack.registry.fail('account.core.immediate', new DeletionRetryError('db'));

    const error = await stack.lifecycle.deleteExplicit(USER).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(EXPLICIT_DELETION_UNAVAILABLE);
    expect(stack.calls).toEqual([
      'begin',
      'routine.stop',
      'telegram.stop',
      'product.stop',
      'calendar.stop',
      'voice.stop',
      'core.immediate',
    ]);
    // runJob глотает ошибку адаптера (jobs.fail + safe warn) — строка задачи
    // остаётся failed, и lifecycle обязан это увидеть пост-проверкой.
    expect(stack.coreRow!.status).toBe('failed');
    expect(stack.coreRow!.lastErrorKind).toBe('db');
  });

  it('assertReady не готов — ошибка всплывает как есть, begin не вызывается', async () => {
    const stack = makeStack({ user: activeUser(), registryNotReady: true });

    await expect(stack.lifecycle.deleteExplicit(USER))
      .rejects.toThrow('deletion_registry_not_ready');

    expect(stack.calls).toEqual([]);
  });
});
