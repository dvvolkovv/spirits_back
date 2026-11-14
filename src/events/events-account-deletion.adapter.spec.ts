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
import { EventsModule } from './events.module';
import { EventsService } from './events.service';
import {
  discoverEventsDeletion,
  EventsAccountDeletionAdapter,
} from './events-account-deletion.adapter';

/**
 * Task 16 — обезличивание events при удалении аккаунта.
 *
 * events — продуктовая аналитика: строки НЕ удаляются, а обезличиваются.
 * user_id/session_id/props стираются только у СОБСТВЕННЫХ строк (user_id или
 * session_id-префикс `<userId>_` через LIKE ... ESCAPE), name/ts/source
 * сохраняются как действительно анонимный агрегат. Чужая referral-атрибуция
 * (props.referee = удалённый userId) не трогается: props не читаются и не
 * используются как ownership evidence. Generation predicate внутри UPDATE
 * делает purge идемпотентным и безопасным при reactivation.
 *
 * Фильтр буфера flush() запрещает поздние записи: после commit удаления
 * события удалённого пользователя (по userId или session-префиксу) не
 * доезжают до таблицы. Один state-запрос на batch (userId + session-префиксы;
 * props НЕ сканируются); при его сбое — fail-closed: batch целиком
 * отбрасывается, как и при любой другой ошибке flush сегодня.
 */

const USER = 'u-deleted';
const LEADER = 'u-leader';
const OWN_CANARY = 'СЕКРЕТ-НЕ-ЛОГИРОВАТЬ';
const LATE_CANARY = 'ЛИЧНЫЙ-ТЕКСТ';
const deletionId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const account: DeletionAccount = {
  userId: USER,
  deletionId,
  deletedAt: new Date('2026-11-14T00:00:00Z'),
};

interface EventRow {
  id: number;
  user_id: string | null;
  session_id: string | null;
  name: string;
  props: Record<string, unknown>;
  source: string | null;
}

/**
 * Фейковая БД: повторяет SQL-семантику адаптера и сервиса (generation gate,
 * scoped UPDATE c LIKE $1 || '\_%' ESCAPE '\', state-фильтр ANY($1::text[]),
 * multi-row INSERT). Неизвестный запрос — throw (чтение props как ownership
 * evidence или левый SQL роняют тест). Журнал calls хранит порядок операций.
 */
class FakeEventsDb {
  readonly users = new Map<string, { state: string; deletionId: string | null }>();
  events: EventRow[] = [];
  readonly queries: Array<{ sql: string; params: any[] }> = [];
  readonly calls: string[] = [];
  /** Отказ state-запроса — проверка fail-closed поведения flush. */
  failStateSelect = false;
  /** Отказ UPDATE — проверка обёртки DeletionRetryError. */
  failUpdate = false;
  private nextId = 1;

  async query(sql: string, params: any[] = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: s, params });

    // Generation gate: discovery и EXISTS-предикат внутри UPDATE.
    if (s.startsWith('SELECT 1 FROM user_id')) {
      const [userId, genId] = params as [string, string];
      const ok = this.isCurrentDeletion(String(userId), String(genId));
      return ok ? { rows: [{ n: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // Фильтр буфера: state='deleted' БЕЗ поколения (flush не знает deletionId).
    if (s.startsWith('SELECT internal_id FROM user_id')) {
      if (this.failStateSelect) throw new Error('state select failed');
      const [ids] = params as [string[]];
      const rows = (ids ?? [])
        .filter((id) => this.users.get(String(id))?.state === 'deleted')
        .map((id) => ({ internal_id: id }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('UPDATE events')) {
      if (this.failUpdate) {
        // SQLSTATE 08006 (connection_failure) → deletionErrorKind = 'db'.
        throw Object.assign(new Error('connection terminated'), { code: '08006' });
      }
      const [userId, genId] = params as [string, string];
      // EXISTS-гейт: поколение не совпало → 0 строк (идемпотентный успех).
      if (!this.isCurrentDeletion(String(userId), String(genId))) {
        return { rows: [], rowCount: 0 };
      }
      let n = 0;
      for (const row of this.events) {
        // LIKE $1 || '\_%' ESCAPE '\': СТРОГИЙ префикс `<userId>_`.
        // 'u-deletedX_...' при userId 'u-deleted' НЕ матчится.
        const byUser = row.user_id === String(userId);
        const bySession = typeof row.session_id === 'string'
          && row.session_id.startsWith(`${userId}_`);
        if (byUser || bySession) {
          row.user_id = null;
          row.session_id = null;
          row.props = {};
          n++;
        }
      }
      this.calls.push('db.updateEvents');
      return { rows: [], rowCount: n };
    }
    if (s.startsWith('INSERT INTO events')) {
      const inserted: EventRow[] = [];
      for (let i = 0; i < params.length; i += 6) {
        const [, userId, sessionId, name, propsJson, source] = params.slice(i, i + 6);
        const row: EventRow = {
          id: this.nextId++,
          user_id: (userId ?? null) as string | null,
          session_id: (sessionId ?? null) as string | null,
          name: String(name),
          props: JSON.parse(String(propsJson)),
          source: (source ?? null) as string | null,
        };
        this.events.push(row);
        inserted.push(row);
      }
      this.calls.push('db.insertEvents');
      return { rows: [], rowCount: inserted.length };
    }
    throw new Error(`unexpected query: ${s}`);
  }

  isCurrentDeletion(userId: string, genId: string): boolean {
    const u = this.users.get(userId);
    return u?.state === 'deleted' && u.deletionId === genId;
  }
}

function makeHarness() {
  const db = new FakeEventsDb();
  db.users.set(USER, { state: 'deleted', deletionId });
  const registry = new AccountDeletionRegistry();
  const adapter = new EventsAccountDeletionAdapter(registry);
  const assertCurrent = jest.fn(async () => undefined);
  const ctx: DeletionExecution & { assertCurrent: jest.Mock } = { db, assertCurrent };
  return { db, registry, adapter, ctx };
}

function eventsJob(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-events-1',
    deletionId,
    userId: USER,
    resourceType: 'events.purge',
    resourceKey: 'events',
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

function ownRow(id: number, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id,
    user_id: USER,
    session_id: `${USER}_roman`,
    name: 'login',
    props: { secret: OWN_CANARY },
    source: 'web',
    ...overrides,
  };
}

describe('discoverEventsDeletion — один пустой job на аккаунт (Task 16)', () => {
  it('payload {}, resourceKey без userId; sanitizer плана проходит', async () => {
    const { db } = makeHarness();

    const plan = await discoverEventsDeletion({ db, account, origin: 'explicit' });

    expect(plan.jobs).toHaveLength(1);
    const job = plan.jobs[0];
    expect(job.resourceType).toBe('events.purge');
    expect(job.phase).toBe('purge');
    expect(job.payload).toEqual({});
    expect(plan.skips).toEqual([]);
    const json = JSON.stringify(plan.jobs);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(OWN_CANARY);
    expect(() => safeDeletionJobSnapshot(job, USER)).not.toThrow();
    // Discovery НЕ читает events — только generation gate (canary-props не
    // покидают таблицу на фазе планирования).
    expect(db.queries.every((q) => q.sql.startsWith('SELECT 1 FROM user_id'))).toBe(true);
  });

  it('reactivation (поколение не совпало) — план пустой', async () => {
    const { db } = makeHarness();
    db.users.set(USER, { state: 'active', deletionId: null });

    const plan = await discoverEventsDeletion({ db, account, origin: 'explicit' });

    expect(plan).toEqual({ jobs: [], skips: [] });
  });
});

describe('EventsAccountDeletionAdapter.execute — scoped обезличивающий UPDATE (Task 16)', () => {
  it('стирает identity/session/props только у собственных events', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.events.push(
      { id: 1, user_id: USER, session_id: 's-1', name: 'login', props: { secret: OWN_CANARY }, source: 'web' },
      { id: 2, user_id: LEADER, session_id: 's-2', name: 'referral', props: { referee: USER }, source: 'web' },
    );

    await adapter.execute(eventsJob(), ctx);

    expect(db.events[0]).toMatchObject({
      user_id: null, session_id: null, props: {}, name: 'login', source: 'web',
    });
    // Чужая referral-связь и агрегат лидера сохраняются полностью.
    expect(db.events[1]).toMatchObject({
      user_id: LEADER, session_id: 's-2', name: 'referral', props: { referee: USER },
    });
    expect(ctx.assertCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'events.purge' }),
    );
    // Canary: чужие/собственные props не уходят ни в один запрос.
    expect(JSON.stringify(db.queries)).not.toContain(OWN_CANARY);
  });

  it('похожий префикс u-deletedX_ не матчится (LIKE c ESCAPE)', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.events.push(
      { id: 1, user_id: null, session_id: 'u-deletedX_roman', name: 'chat', props: { keep: true }, source: 'web' },
      { id: 2, user_id: null, session_id: `${USER}_roman`, name: 'chat', props: { drop: true }, source: 'web' },
    );

    await adapter.execute(eventsJob(), ctx);

    expect(db.events[0]).toMatchObject({ session_id: 'u-deletedX_roman', props: { keep: true } });
    expect(db.events[1]).toMatchObject({ user_id: null, session_id: null, props: {}, name: 'chat' });

    const upd = db.queries.find((q) => q.sql.startsWith('UPDATE events'));
    expect(upd).toBeDefined();
    // Строка из плана verbatim: LIKE c экранированным '_' и generation gate.
    expect(upd!.sql).toContain(String.raw`LIKE $1 || '\_%' ESCAPE '\'`);
    expect(upd!.sql).toContain(`u.state='deleted'`);
    expect(upd!.sql).toContain('u.deletion_id=$2');
    expect(upd!.params).toEqual([USER, deletionId]);
  });

  it('generation mismatch — UPDATE матчит 0 строк, тихий успех', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.users.set(USER, { state: 'deleted', deletionId: 'other-generation' });
    db.events.push(ownRow(1));

    await expect(adapter.execute(eventsJob(), ctx)).resolves.toBeUndefined();
    expect(db.events[0]).toMatchObject({ user_id: USER, session_id: `${USER}_roman` });
  });

  it('reactivation между discovery и execute — DeletionCancelledError, UPDATE не исполнен', async () => {
    const { db, adapter, ctx } = makeHarness();
    ctx.assertCurrent.mockRejectedValue(new DeletionCancelledError());
    db.events.push(ownRow(1));

    await expect(adapter.execute(eventsJob(), ctx)).rejects.toBeInstanceOf(DeletionCancelledError);
    expect(db.calls).not.toContain('db.updateEvents');
    expect(db.events[0]).toMatchObject({ user_id: USER });
  });

  it('сбой БД — DeletionRetryError(kind db), строки не тронуты', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.failUpdate = true;
    db.events.push(ownRow(1));

    await expect(adapter.execute(eventsJob(), ctx)).rejects.toMatchObject({ kind: 'db' });
    expect(db.events[0]).toMatchObject({ user_id: USER });
  });

  it('идемпотентность: повторный execute — тихий успех', async () => {
    const { db, adapter, ctx } = makeHarness();
    db.events.push(ownRow(1));

    await adapter.execute(eventsJob(), ctx);
    await expect(adapter.execute(eventsJob(), ctx)).resolves.toBeUndefined();
    expect(db.events[0]).toMatchObject({ user_id: null, session_id: null, props: {} });
  });

  it('чужой resourceType — отказ', async () => {
    const { adapter, ctx } = makeHarness();
    const job = { ...eventsJob(), resourceType: 'avatar.purge' as const };

    await expect(adapter.execute(job, ctx)).rejects.toThrow('unsupported_deletion_resource');
  });
});

describe('EventsService.flush — поздние записи удалённого пользователя (Task 16)', () => {
  // Отклонение от имени в плане (flushForTest): приватный flush вызывается
  // кастом — test-only API в production-код не добавляется.
  function makeService() {
    const db = new FakeEventsDb();
    const events = new EventsService(db as any);
    const flush = (events as unknown as { flush(): Promise<void> }).flush.bind(events);
    return { db, events, flush };
  }

  it('buffer flush отбрасывает deleted user и его session после commit deletion', async () => {
    const { db, events, flush } = makeService();
    db.users.set(USER, { state: 'deleted', deletionId });

    events.track('late', { userId: USER, props: { text: LATE_CANARY } });
    events.track('late-session', { sessionId: `${USER}_roman` });
    await flush();

    expect(db.events).toHaveLength(0);
    expect(db.calls).not.toContain('db.insertEvents');
  });

  it('живые события вставляются; state-запрос один на batch, sessionId целиком не кандидат', async () => {
    const { db, events, flush } = makeService();
    db.users.set(USER, { state: 'deleted', deletionId });
    db.users.set(LEADER, { state: 'active', deletionId: null });

    events.track('a', { userId: LEADER });
    events.track('b', { userId: USER });
    events.track('c', { sessionId: `${USER}_roman` });
    await flush();

    expect(db.events).toHaveLength(1);
    expect(db.events[0]).toMatchObject({ user_id: LEADER, name: 'a' });
    const stateSelects = db.queries.filter((q) => q.sql.startsWith('SELECT internal_id FROM user_id'));
    expect(stateSelects).toHaveLength(1);
    expect(stateSelects[0].params[0]).toEqual(expect.arrayContaining([LEADER, USER]));
    expect(stateSelects[0].params[0]).not.toContain(`${USER}_roman`);
  });

  it('анонимные события (без userId/sessionId или без "_" в session) проходят без state-запроса', async () => {
    const { db, events, flush } = makeService();
    db.users.set(USER, { state: 'deleted', deletionId });

    events.track('landing_view', { props: { utm: 'vk' } });
    events.track('funnel_step', { sessionId: 'no-underscore' });
    await flush();

    expect(db.events).toHaveLength(2);
    expect(db.queries.filter((q) => q.sql.startsWith('SELECT internal_id'))).toHaveLength(0);
  });

  it('props-only совпадение не ownership evidence: чужое referral-событие переживает flush', async () => {
    const { db, events, flush } = makeService();
    db.users.set(USER, { state: 'deleted', deletionId });
    db.users.set(LEADER, { state: 'active', deletionId: null });

    events.track('referral', { userId: LEADER, props: { referee: USER } });
    events.track('signup', { props: { invited_by: USER } });
    await flush();

    expect(db.events).toHaveLength(2);
    expect(db.events[0]).toMatchObject({ user_id: LEADER, props: { referee: USER } });
    expect(db.events[1]).toMatchObject({ user_id: null, props: { invited_by: USER } });
  });

  it('чужой session-префикс u-deletedX не отбрасывается', async () => {
    const { db, events, flush } = makeService();
    db.users.set(USER, { state: 'deleted', deletionId });

    events.track('x', { sessionId: 'u-deletedX_roman' });
    await flush();

    expect(db.events).toHaveLength(1);
    expect(db.events[0]).toMatchObject({ session_id: 'u-deletedX_roman' });
  });

  it('сбой state-запроса — fail-closed: batch целиком отброшен, живые события не вставлены', async () => {
    const { db, events, flush } = makeService();
    db.failStateSelect = true;
    db.users.set(LEADER, { state: 'active', deletionId: null });

    events.track('a', { userId: LEADER });
    await expect(flush()).resolves.toBeUndefined();

    expect(db.events).toHaveLength(0);
    expect(db.calls).not.toContain('db.insertEvents');
  });
});

describe('wiring events.purge (Task 16)', () => {
  it('adapter регистрирует events.purge, EventsModule его провайдит', () => {
    const registry = { register: jest.fn() } as any;
    const adapter = new EventsAccountDeletionAdapter(registry);
    expect(adapter.resourceTypes).toEqual(['events.purge']);
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);

    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, EventsModule) ?? []).flat(Infinity);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, EventsModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === EventsAccountDeletionAdapter)).toHaveLength(1);
  });

  it('catalog содержит discoverEventsDeletion ровно один раз', () => {
    expect(
      DELETION_DISCOVERERS.filter((item) => item === discoverEventsDeletion),
    ).toHaveLength(1);
  });
});
