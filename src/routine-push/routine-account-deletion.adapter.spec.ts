import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { DELETION_DISCOVERERS } from '../account-deletion/account-deletion.catalog';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { RoutinePushModule } from './routine-push.module';
import { RoutinePushService } from './routine-push.service';
import { RoutineStore } from './routine-store.service';
import {
  RoutineAccountDeletionAdapter,
  discoverRoutinePushDeletion,
} from './routine-account-deletion.adapter';

interface FakeUser {
  state: 'active' | 'deleted';
  deletionId: string | null;
}

class FakeDeletionDb {
  readonly users = new Map<string, FakeUser>();
  routines: Array<Record<string, any>> = [];
  subscriptions: Array<{ userId: string; endpoint: string }> = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];

  async query(sql: string, params: any[] = []) {
    this.queries.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT r.id FROM routine_pushes r WHERE r.user_id=$1')) {
      return {
        rows: this.routines
          .filter((routine) => routine.userId === params[0])
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .map((routine) => ({ id: routine.id })),
        rowCount: this.routines.filter((routine) => routine.userId === params[0]).length,
      };
    }
    if (s.startsWith('SELECT 1 FROM push_subscriptions s WHERE s.user_id=$1')) {
      const found = this.subscriptions.some((subscription) => subscription.userId === params[0]);
      return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
    }
    if (s.startsWith('UPDATE routine_pushes r SET enabled=false')) {
      const [routineId, userId, deletionId] = params;
      const routine = this.routines.find((candidate) => candidate.id === routineId && candidate.userId === userId);
      if (!routine || !this.isCurrentDeletion(userId, deletionId)) {
        return { rows: [], rowCount: 0 };
      }
      routine.enabled = false;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM routine_pushes r')) {
      const [routineId, userId, deletionId] = params;
      const before = this.routines.length;
      this.routines = this.routines.filter((routine) => !(
        routine.id === routineId
        && routine.userId === userId
        && this.isCurrentDeletion(userId, deletionId)
      ));
      return { rows: [], rowCount: before - this.routines.length };
    }
    if (s.startsWith('DELETE FROM push_subscriptions s')) {
      const [userId, deletionId] = params;
      const before = this.subscriptions.length;
      this.subscriptions = this.subscriptions.filter((subscription) => !(
        subscription.userId === userId && this.isCurrentDeletion(userId, deletionId)
      ));
      return { rows: [], rowCount: before - this.subscriptions.length };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  private isCurrentDeletion(userId: string, deletionId: string): boolean {
    const user = this.users.get(userId);
    return user?.state === 'deleted' && user.deletionId === deletionId;
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
    id: `job-${resourceType}-${resourceKey}`,
    deletionId,
    userId: account.userId,
    resourceType,
    resourceKey,
    phase: resourceType === 'routine.stop' ? 'immediate' : 'purge',
    payload: resourceType === 'push.purge' ? {} : { routineId: resourceKey },
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-11T00:00:00Z'),
    leaseUntil: new Date('2026-11-11T01:00:00Z'),
    lastErrorKind: null,
  };
}

function makeAdapter(db: FakeDeletionDb) {
  const routines = { clearRetryTimersForUser: jest.fn() };
  const adapter = new RoutineAccountDeletionAdapter(db as any, routines as any, new AccountDeletionRegistry());
  return { adapter, routines };
}

function execution(db: FakeDeletionDb): DeletionExecution & { assertCurrent: jest.Mock } {
  return { db: db as any, assertCurrent: jest.fn(async () => {}) };
}

describe('routine/push deletion discovery', () => {
  it('создаёт stop/purge для каждой routine ID и один push.purge без личных payload', async () => {
    const db = new FakeDeletionDb();
    db.routines = [
      { id: 'routine-2', userId: account.userId, title: 'Личное название', prompt: 'Личный prompt' },
      { id: 'routine-1', userId: account.userId, title: 'Ещё название', prompt: 'Ещё prompt' },
      { id: 'routine-other', userId: 'u-other' },
    ];
    db.subscriptions = [
      { userId: account.userId, endpoint: 'https://private.example/endpoint' },
      { userId: 'u-other', endpoint: 'https://neighbor.example/endpoint' },
    ];

    const plan = await discoverRoutinePushDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.skips).toEqual([]);
    expect(plan.jobs.map((item) => [item.resourceType, item.resourceKey, item.phase])).toEqual([
      ['routine.stop', 'routine-1', 'immediate'],
      ['routine.purge', 'routine-1', 'purge'],
      ['routine.stop', 'routine-2', 'immediate'],
      ['routine.purge', 'routine-2', 'purge'],
      ['push.purge', 'push', 'purge'],
    ]);
    for (const item of plan.jobs) {
      expect(Object.keys(item.payload)).toEqual(item.resourceType === 'push.purge' ? [] : ['routineId']);
    }
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('Личное');
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('endpoint');
    expect(serialized).not.toContain(account.userId);
    expect(await discoverRoutinePushDeletion({ db: db as any, account, origin: 'explicit' })).toEqual(plan);
  });

  it('без subscriptions не создаёт push.purge', async () => {
    const db = new FakeDeletionDb();
    db.routines = [{ id: 'routine-1', userId: account.userId }];
    const plan = await discoverRoutinePushDeletion({ db: db as any, account, origin: 'merge' });
    expect(plan.jobs.filter((item) => item.resourceType === 'push.purge')).toEqual([]);
  });
});

describe('RoutineAccountDeletionAdapter', () => {
  beforeEach(() => {
    account.userId = 'u-deleted';
  });

  it('stop отключает только routine владельца, чистит его timers и идемпотентен', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.users.set('u-other', { state: 'active', deletionId: null });
    db.routines = [
      { id: 'routine-1', userId: account.userId, enabled: true },
      { id: 'routine-2', userId: account.userId, enabled: true },
      { id: 'routine-other', userId: 'u-other', enabled: true },
    ];
    const { adapter, routines } = makeAdapter(db);
    const stop = job('routine.stop', 'routine-1');

    await adapter.execute(stop, execution(db));
    expect(db.routines).toEqual([
      { id: 'routine-1', userId: account.userId, enabled: false },
      { id: 'routine-2', userId: account.userId, enabled: true },
      { id: 'routine-other', userId: 'u-other', enabled: true },
    ]);
    expect(routines.clearRetryTimersForUser).toHaveBeenCalledTimes(1);
    expect(routines.clearRetryTimersForUser).toHaveBeenCalledWith(account.userId);

    await adapter.execute(stop, execution(db));
    expect(routines.clearRetryTimersForUser).toHaveBeenCalledTimes(2);
    expect(db.routines.find((routine) => routine.id === 'routine-other')?.enabled).toBe(true);
  });

  it('purge вызывает assertCurrent и удаляет только ресурсы владельца; повтор безопасен', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.users.set('u-other', { state: 'active', deletionId: null });
    db.routines = [
      { id: 'routine-1', userId: account.userId },
      { id: 'routine-other', userId: 'u-other' },
    ];
    db.subscriptions = [
      { userId: account.userId, endpoint: 'https://private.example/endpoint' },
      { userId: 'u-other', endpoint: 'https://neighbor.example/endpoint' },
    ];
    const { adapter } = makeAdapter(db);
    const ctx = execution(db);

    await adapter.execute(job('routine.purge', 'routine-1'), ctx);
    await adapter.execute(job('routine.purge', 'routine-1'), ctx);
    await adapter.execute(job('push.purge', 'push'), ctx);
    await adapter.execute(job('push.purge', 'push'), ctx);

    expect(ctx.assertCurrent).toHaveBeenCalledTimes(4);
    expect(db.routines).toEqual([{ id: 'routine-other', userId: 'u-other' }]);
    expect(db.subscriptions).toEqual([{ userId: 'u-other', endpoint: 'https://neighbor.example/endpoint' }]);
  });

  it('после reactivation старый deletionId ничего не отключает, не удаляет и не чистит timers', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'active', deletionId: 'deletion-new' });
    db.routines = [{ id: 'routine-1', userId: account.userId, enabled: true }];
    db.subscriptions = [{ userId: account.userId, endpoint: 'https://new.example/endpoint' }];
    const { adapter, routines } = makeAdapter(db);
    const ctx = execution(db);

    await adapter.execute(job('routine.stop', 'routine-1'), ctx);
    await adapter.execute(job('routine.purge', 'routine-1'), ctx);
    await adapter.execute(job('push.purge', 'push'), ctx);

    expect(db.routines).toEqual([{ id: 'routine-1', userId: account.userId, enabled: true }]);
    expect(db.subscriptions).toHaveLength(1);
    expect(routines.clearRetryTimersForUser).not.toHaveBeenCalled();
  });

  it('normalized destructive SQL сам содержит owner/state/deletion predicates', async () => {
    const db = new FakeDeletionDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.routines = [{ id: 'routine-1', userId: account.userId, enabled: true }];
    db.subscriptions = [{ userId: account.userId, endpoint: 'https://private.example/endpoint' }];
    const { adapter } = makeAdapter(db);

    await adapter.execute(job('routine.stop', 'routine-1'), execution(db));
    await adapter.execute(job('routine.purge', 'routine-1'), execution(db));
    await adapter.execute(job('push.purge', 'push'), execution(db));

    const normalized = db.queries.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
    const stop = normalized.find((sql) => sql.startsWith('UPDATE routine_pushes r SET enabled=false'))!;
    const routinePurge = normalized.find((sql) => sql.startsWith('DELETE FROM routine_pushes r'))!;
    const pushPurge = normalized.find((sql) => sql.startsWith('DELETE FROM push_subscriptions s'))!;
    for (const sql of [stop, routinePurge]) {
      expect(sql).toContain('r.id=$1');
      expect(sql).toContain('r.user_id=$2');
      expect(sql).toContain('u.internal_id=$2');
      expect(sql).toContain("u.state='deleted'");
      expect(sql).toContain('u.deletion_id=$3');
    }
    expect(pushPurge).toContain('s.user_id=$1');
    expect(pushPurge).toContain('u.internal_id=$1');
    expect(pushPurge).toContain("u.state='deleted'");
    expect(pushPurge).toContain('u.deletion_id=$2');
  });

  it('регистрируется в существующем Registry без глобального assertReady', () => {
    const db = new FakeDeletionDb();
    const registry = new AccountDeletionRegistry();
    const ready = jest.spyOn(registry, 'assertReady');
    const adapter = new RoutineAccountDeletionAdapter(db as any, { clearRetryTimersForUser: jest.fn() } as any, registry);

    adapter.onModuleInit();

    for (const resourceType of ['routine.stop', 'routine.purge', 'push.purge'] as const) {
      expect(registry.getExecutor(resourceType)).toBe(adapter);
    }
    expect(ready).not.toHaveBeenCalled();
  });

  it('catalog и RoutinePushModule содержат обязательную wiring', () => {
    expect(DELETION_DISCOVERERS).toContain(discoverRoutinePushDeletion);
    expect(Reflect.getMetadata('providers', RoutinePushModule)).toContain(RoutineAccountDeletionAdapter);
    expect(Reflect.getMetadata('imports', RoutinePushModule)).toContain(AccountDeletionModule);
  });
});

describe('clearRetryTimersForUser', () => {
  afterEach(() => jest.useRealTimers());

  it('освобождает timers только указанного владельца', () => {
    jest.useFakeTimers();
    const svc = new RoutinePushService({} as any, {} as any, {} as any, {} as any);
    const own = setTimeout(() => {}, 60_000);
    const ownSecond = setTimeout(() => {}, 60_000);
    const neighbor = setTimeout(() => {}, 60_000);
    (svc as any).retryTimers.set('u-deleted:routine-1', own);
    (svc as any).retryTimers.set('u-deleted:routine-2', ownSecond);
    (svc as any).retryTimers.set('u-other:routine-1', neighbor);

    svc.clearRetryTimersForUser('u-deleted');

    expect([...(svc as any).retryTimers.keys()]).toEqual(['u-other:routine-1']);
    clearTimeout(neighbor);
  });
});

describe('RoutineStore active fences', () => {
  const current = {
    id: 'routine-1', user_id: account.userId, title: 'before', assistant_id: '14', prompt: 'before',
    send_hour: 8, tz: 'Europe/Moscow', days: null, enabled: true, last_sent_date: null,
  };

  function makeStore(state: 'active' | 'deleted') {
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (s.startsWith("SELECT 1 FROM user_id WHERE internal_id=$1 AND state='active'")) {
          return { rows: state === 'active' ? [{ '?column?': 1 }] : [], rowCount: state === 'active' ? 1 : 0 };
        }
        if (s.startsWith('SELECT count(*)::int AS n FROM routine_pushes')) {
          return { rows: [{ n: 0 }], rowCount: 1 };
        }
        if (s.startsWith('SELECT id, user_id, title, assistant_id, prompt, send_hour, tz, days, enabled, last_sent_date FROM routine_pushes WHERE user_id = $1 AND id = $2')) {
          return { rows: [{ ...current }], rowCount: 1 };
        }
        if (s.startsWith('INSERT INTO routine_pushes')) {
          return { rows: [{ ...current, id: 'routine-new', title: params[1], prompt: params[3] }], rowCount: 1 };
        }
        if (s.startsWith('UPDATE routine_pushes SET title=')) {
          return { rows: [{ ...current, title: params[2], prompt: params[4] }], rowCount: 1 };
        }
        if (s.startsWith('SELECT r.id,r.user_id,r.title')) {
          const fenced = s.includes("JOIN user_id u ON u.internal_id=r.user_id AND u.state='active'");
          const visible = state === 'active' || !fenced;
          return { rows: visible ? [{ ...current }] : [], rowCount: visible ? 1 : 0 };
        }
        if (s.startsWith('UPDATE routine_pushes r SET last_sent_date=')) {
          const fenced = s.includes("u.state='active'");
          const claimed = state === 'active' || !fenced;
          return { rows: claimed ? [{ id: params[0] }] : [], rowCount: claimed ? 1 : 0 };
        }
        throw new Error(`unexpected query: ${s}`);
      }),
    };
    return { store: new RoutineStore(pg as any), pg };
  }

  it('listEnabled исключает deleted, но сохраняет active', async () => {
    expect(await makeStore('deleted').store.listEnabled()).toEqual([]);
    expect(await makeStore('active').store.listEnabled()).toHaveLength(1);
  });

  it('claimToday сохраняет CAS, enabled/owner и не даёт deleted застолбить день', async () => {
    const deleted = makeStore('deleted');
    expect(await (deleted.store as any).claimToday('routine-1', '2026-11-11', account.userId)).toBe(false);
    const active = makeStore('active');
    expect(await (active.store as any).claimToday('routine-1', '2026-11-11', account.userId)).toBe(true);
    const call = active.pg.query.mock.calls.find(([query]) => String(query).includes('SET last_sent_date='));
    const sql = String(call?.[0]).replace(/\s+/g, ' ');
    expect(sql).toContain('r.enabled=true');
    expect(sql).toContain('r.user_id=$3');
    expect(sql).toContain('last_sent_date IS DISTINCT FROM $2');
    expect(sql).toContain("u.state='active'");
    expect(sql).toContain('RETURNING r.id');
    expect(call?.[1]).toEqual(['routine-1', '2026-11-11', account.userId]);
  });

  it('create/update не создают и не обновляют deleted, active contracts сохраняются', async () => {
    const data = { title: 'after', assistantId: '14', prompt: 'after' };
    const deleted = makeStore('deleted');
    expect(await deleted.store.create(account.userId, data)).toBeNull();
    expect(await deleted.store.update(account.userId, 'routine-1', data)).toBeNull();
    expect(deleted.pg.query.mock.calls.filter(([sql]) => /INSERT INTO routine_pushes|UPDATE routine_pushes SET title=/.test(String(sql)))).toEqual([]);

    const active = makeStore('active');
    expect((await active.store.create(account.userId, data))?.id).toBe('routine-new');
    expect((await active.store.update(account.userId, 'routine-1', data))?.title).toBe('after');
  });
});

describe('RoutineStore claim/release CAS', () => {
  function makeCasStore(routine: { id: string; userId: string; enabled: boolean; lastSentDate: string | null }) {
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (s.startsWith('UPDATE routine_pushes r SET last_sent_date=')) {
          const fenced = s.includes('r.enabled=true')
            && s.includes('r.user_id=$3')
            && s.includes("u.state='active'")
            && s.includes('last_sent_date IS DISTINCT FROM $2');
          const distinct = routine.lastSentDate !== params[1];
          const claimed = fenced
            ? distinct && routine.enabled && routine.userId === params[2]
            : distinct;
          if (claimed) routine.lastSentDate = params[1];
          return { rows: claimed ? [{ id: routine.id }] : [], rowCount: claimed ? 1 : 0 };
        }
        if (s.startsWith('UPDATE routine_pushes SET last_sent_date=')) {
          const cas = /WHERE id\s*=\s*\$1 AND last_sent_date\s*=\s*\$2/.test(s);
          const released = cas && routine.lastSentDate === params[1];
          if (released) routine.lastSentDate = params[2];
          return { rows: released ? [{ id: routine.id }] : [], rowCount: released ? 1 : 0 };
        }
        throw new Error(`unexpected query: ${s}`);
      }),
    };
    return { store: new RoutineStore(pg as any), pg };
  }

  it.each(['disabled', 'owner'])('%s между get и claim не даёт застолбить день', async (race) => {
    const routine = { id: 'routine-1', userId: account.userId, enabled: true, lastSentDate: null };
    if (race === 'disabled') routine.enabled = false;
    else routine.userId = 'u-other';
    const { store } = makeCasStore(routine);

    expect(await (store as any).claimToday('routine-1', '2026-11-11', account.userId)).toBe(false);
    expect(routine.lastSentDate).toBeNull();
  });

  it('releaseToday восстанавливает prev только по своему today claim', async () => {
    const routine = { id: 'routine-1', userId: account.userId, enabled: true, lastSentDate: '2026-11-11' };
    const { store, pg } = makeCasStore(routine);

    expect(await (store as any).releaseToday('routine-1', '2026-11-11', '2026-11-04')).toBe(true);
    expect(routine.lastSentDate).toBe('2026-11-04');
    expect(pg.query).toHaveBeenCalledWith(expect.stringMatching(/last_sent_date\s*=\s*\$3/), [
      'routine-1', '2026-11-11', '2026-11-04',
    ]);
  });

  it('releaseToday не затирает более новый claim', async () => {
    const routine = { id: 'routine-1', userId: account.userId, enabled: true, lastSentDate: '2026-11-12' };
    const { store } = makeCasStore(routine);

    expect(await (store as any).releaseToday('routine-1', '2026-11-11', '2026-11-04')).toBe(false);
    expect(routine.lastSentDate).toBe('2026-11-12');
  });
});

describe('RoutineStore atomic active write fence', () => {
  function makeWriteRaceStore() {
    let state: 'active' | 'deleted' = 'active';
    let firstActiveSelect = true;
    const created: any[] = [];
    const current = {
      id: 'routine-1', user_id: account.userId, title: 'before', assistant_id: '14', prompt: 'before',
      send_hour: 8, tz: 'Europe/Moscow', days: null, enabled: true, last_sent_date: null,
    };
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (s.startsWith("SELECT 1 FROM user_id WHERE internal_id=$1 AND state='active'") && firstActiveSelect) {
          firstActiveSelect = false;
          state = 'deleted';
          return { rows: [{ '?column?': 1 }], rowCount: 1 };
        }
        if (s.startsWith('SELECT count(*)::int AS n FROM routine_pushes')) {
          return { rows: [{ n: 0 }], rowCount: 1 };
        }
        if (s.startsWith('SELECT id, user_id, title, assistant_id, prompt, send_hour, tz, days, enabled, last_sent_date FROM routine_pushes WHERE user_id = $1 AND id = $2')) {
          return { rows: [{ ...current }], rowCount: 1 };
        }
        if (s.startsWith('INSERT INTO routine_pushes')) {
          const guarded = s.includes('WHERE EXISTS') && s.includes("state='active'");
          if (state === 'deleted' && guarded) return { rows: [], rowCount: 0 };
          const row = { ...current, id: 'routine-new', title: params[1], prompt: params[3] };
          created.push(row);
          return { rows: [row], rowCount: 1 };
        }
        if (s.startsWith('UPDATE routine_pushes SET title=')) {
          const guarded = s.includes('AND EXISTS') && s.includes("u.state='active'");
          if (state === 'deleted' && guarded) return { rows: [], rowCount: 0 };
          current.title = params[2];
          current.prompt = params[4];
          return { rows: [{ ...current }], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${s}`);
      }),
    };
    return { store: new RoutineStore(pg as any), created, current };
  }

  it('create не пишет, если deleted наступил после active SELECT', async () => {
    const { store, created } = makeWriteRaceStore();
    expect(await store.create(account.userId, { title: 'after', assistantId: '14', prompt: 'after' })).toBeNull();
    expect(created).toEqual([]);
  });

  it('update не пишет, если deleted наступил после active SELECT', async () => {
    const { store, current } = makeWriteRaceStore();
    expect(await store.update(account.userId, 'routine-1', { title: 'after', prompt: 'after' })).toBeNull();
    expect(current.title).toBe('before');
    expect(current.prompt).toBe('before');
  });
});
