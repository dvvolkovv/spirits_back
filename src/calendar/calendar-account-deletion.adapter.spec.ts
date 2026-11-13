import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { DELETION_DISCOVERERS, DELETION_DEPENDENCIES } from '../account-deletion/account-deletion.catalog';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { assertSafeSkip, safeDeletionJobSnapshot } from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { CalendarModule } from './calendar.module';
import {
  CalendarAccountDeletionAdapter,
  discoverCalendarDeletion,
} from './calendar-account-deletion.adapter';

/**
 * Task 9 — календарь при удалении аккаунта.
 *
 * Главное правило: внешнее событие нельзя удалить, если мы не можем ДОКАЗАТЬ,
 * что оно личное и создано Линкеоном. UID в предложении может принадлежать
 * общему календарю («shared-1») — внешний DELETE по нему стёр бы чужую встречу.
 * Поэтому discovery без durable ownership evidence emits фиксированный skip
 * (calendar.external / owner_unverifiable), а локальные строки (proposals,
 * connections, ICS-источники) чистятся purge-задачей с generation predicate.
 */

interface FakeUser {
  state: 'active' | 'deleted';
  deletionId: string | null;
}

class FakeCalendarDb {
  readonly users = new Map<string, FakeUser>();
  proposals: Array<Record<string, any>> = [];
  connections: Array<Record<string, any>> = [];
  tripCalendars: Array<Record<string, any>> = [];
  linkeonTasks: Array<Record<string, any>> = [];
  dayFraming: Array<Record<string, any>> = [];
  /** Канарейка: календарный адаптер не имеет права трогать интеграционные таблицы. */
  integrationFlags: Array<Record<string, any>> = [{ id: 'flag-1', kind: 'zoom' }];
  readonly queries: Array<{ sql: string; params: any[] }> = [];

  async query(sql: string, params: any[] = []) {
    this.queries.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT c.provider FROM calendar_connections c WHERE c.user_id=$1')) {
      const rows = this.connections
        .filter((c) => c.user_id === params[0])
        .map((c) => ({ provider: c.provider }))
        .sort((a, b) => String(a.provider).localeCompare(String(b.provider)));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT p.id,p.event FROM calendar_proposals p WHERE p.user_id=$1')) {
      const rows = this.proposals
        .filter((p) => p.user_id === params[0])
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((p) => ({ id: p.id, event: p.event }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('SELECT 1 FROM trip_calendars t WHERE t.user_id=$1')) {
      const found = this.tripCalendars.some((t) => t.user_id === params[0]);
      return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
    }
    if (s.startsWith('DELETE FROM calendar_proposals p')) {
      return this.deleteOwned('proposals', params);
    }
    if (s.startsWith('DELETE FROM trip_calendars t')) {
      return this.deleteOwned('tripCalendars', params);
    }
    if (s.startsWith('DELETE FROM calendar_connections c')) {
      return this.deleteOwned('connections', params);
    }
    if (s.startsWith('DELETE FROM linkeon_tasks l')) {
      return this.deleteOwned('linkeonTasks', params);
    }
    if (s.startsWith('DELETE FROM day_framing d')) {
      return this.deleteOwned('dayFraming', params);
    }
    throw new Error(`unexpected query: ${s}`);
  }

  private deleteOwned(
    field: 'proposals' | 'tripCalendars' | 'connections' | 'linkeonTasks' | 'dayFraming',
    params: any[],
  ) {
    const [userId, deletionId] = params;
    if (!this.isCurrentDeletion(userId, deletionId)) return { rows: [], rowCount: 0 };
    const before = this[field].length;
    this[field] = this[field].filter((row) => row.user_id !== userId);
    return { rows: [], rowCount: before - this[field].length };
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
    phase: resourceType === 'calendar.stop' ? 'immediate' : 'purge',
    payload: resourceType === 'calendar.stop' ? { provider: resourceKey } : {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-11T00:00:00Z'),
    leaseUntil: new Date('2026-11-11T01:00:00Z'),
    lastErrorKind: null,
  };
}

function makeCalendar() {
  return {
    disconnect: jest.fn(async () => {}),
    disconnectExchange: jest.fn(async () => {}),
    deleteEvent: jest.fn(async () => ({ ok: true })),
  };
}

function makeAdapter(db: FakeCalendarDb, calendar = makeCalendar()) {
  const adapter = new CalendarAccountDeletionAdapter(
    db as any,
    calendar as any,
    new AccountDeletionRegistry(),
  );
  return { adapter, calendar };
}

function execution(db: FakeCalendarDb): DeletionExecution & { assertCurrent: jest.Mock } {
  return { db: db as any, assertCurrent: jest.fn(async () => {}) };
}

function seed(db: FakeCalendarDb) {
  db.users.set(account.userId, { state: 'deleted', deletionId });
  db.proposals.push({
    id: 'pr-1',
    user_id: account.userId,
    event: { uid: 'shared-1', title: 'ЛИЧНЫЙ-ТЕКСТ' },
  });
  db.connections.push({
    id: 'cal-1',
    user_id: account.userId,
    provider: 'yandex',
    enabled: true,
  });
  db.tripCalendars.push({
    user_id: account.userId,
    kind: 'outlook',
    url: 'https://private.example/cal.ics',
    enabled: true,
  });
  db.linkeonTasks.push({ uid: 'lt-1', user_id: account.userId, title: 'Дело' });
  db.dayFraming.push({
    user_id: account.userId,
    day: '2026-11-01',
    kind: 'morning',
    text: 'ФРЕЙМ-ТЕКСТ',
  });
}

describe('calendar deletion discovery', () => {
  it('external event без durable ownership evidence не удаляется, local rows очищаются', async () => {
    const db = new FakeCalendarDb();
    seed(db);
    const { adapter, calendar } = makeAdapter(db);

    const plan = await discoverCalendarDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.skips).toContainEqual({
      resourceType: 'calendar.external',
      reason: 'owner_unverifiable',
    });
    for (const skip of plan.skips) expect(() => assertSafeSkip(skip)).not.toThrow();
    // Discovery только читает: никакой внешний DELETE на этом шаге недопустим.
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    // stop по каждому подключению + один purge; всё техническое, phase по типу.
    expect(plan.jobs.map((item) => [item.resourceType, item.resourceKey, item.phase])).toEqual([
      ['calendar.stop', 'yandex', 'immediate'],
      ['calendar.purge', 'calendar', 'purge'],
    ]);
    for (const item of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(item, account.userId)).not.toThrow();
    }
    // Личный текст события, URL ICS и userId не покидают discovery.
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('ЛИЧНЫЙ');
    expect(serialized).not.toContain('shared-1');
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain(account.userId);

    await adapter.execute(job('calendar.purge', 'calendar'), execution(db));
    expect(db.proposals).toHaveLength(0);
    expect(db.connections).toHaveLength(0);
    expect(db.tripCalendars).toHaveLength(0);
    // Review I-4: локальный «дом дел» и фреймы дня — тоже calendar/trip-домен,
    // их стирает calendar.purge тем же generation predicate.
    expect(db.linkeonTasks).toHaveLength(0);
    expect(db.dayFraming).toHaveLength(0);
  });

  it('без локальных строк не создаёт задач, чужие строки не трогает', async () => {
    const db = new FakeCalendarDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.proposals.push({ id: 'pr-other', user_id: 'u-other', event: { uid: 'x' } });
    db.connections.push({ id: 'cal-other', user_id: 'u-other', provider: 'yandex' });

    const plan = await discoverCalendarDeletion({ db: db as any, account, origin: 'merge' });

    expect(plan.jobs).toEqual([]);
    expect(plan.skips).toEqual([]);
  });

  it('предложение без uid не даёт skip: внешне удалять нечего', async () => {
    const db = new FakeCalendarDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.proposals.push({ id: 'pr-2', user_id: account.userId, event: { title: 'без uid' } });

    const plan = await discoverCalendarDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.skips).toEqual([]);
    expect(plan.jobs.map((item) => item.resourceType)).toEqual(['calendar.purge']);
  });

  it('durable ownership evidence (createdByLinkeon) снимает skip', async () => {
    const db = new FakeCalendarDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.proposals.push({
      id: 'pr-3',
      user_id: account.userId,
      event: { uid: 'own-1', createdByLinkeon: true },
    });

    const plan = await discoverCalendarDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.skips).toEqual([]);
    // Но и с evidence discovery НЕ вызывает внешний DELETE: удаление внешних
    // событий — не часть локального purge (calendar.external — skip-only тип).
    expect(plan.jobs.map((item) => item.resourceType)).toEqual(['calendar.purge']);
  });

  it('отравленная строка provider даёт безопасный enum resourceKey и не бросает (review I-1)', async () => {
    // CalendarController.connect исторически пропускал body.provider без
    // валидации; строка вроде 'Yandex 360' (пробел) или 'yandex ' (хвостовой
    // пробел) ломает RESOURCE_KEY_RE/unsafePayloadString в sanitizer'е, и
    // ОШИБКА ОДНОГО discoverer'а роняет весь planner.collect. Discovery обязан
    // clamp'ить provider в фиксированный enum и дедуплицировать stop-задачи.
    const db = new FakeCalendarDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.connections.push({ id: 'cal-bad1', user_id: account.userId, provider: 'Yandex 360' });
    db.connections.push({ id: 'cal-bad2', user_id: account.userId, provider: 'yandex ' });
    db.connections.push({ id: 'cal-ex', user_id: account.userId, provider: 'exchange' });
    db.connections.push({ id: 'cal-long', user_id: account.userId, provider: 'x'.repeat(200) });

    const plan = await discoverCalendarDeletion({ db: db as any, account, origin: 'explicit' });

    const stops = plan.jobs.filter((item) => item.resourceType === 'calendar.stop');
    expect(stops.map((item) => item.resourceKey).sort()).toEqual(['exchange', 'yandex']);
    for (const item of plan.jobs) {
      expect(() => safeDeletionJobSnapshot(item, account.userId)).not.toThrow();
    }
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('Yandex 360');
    expect(serialized).not.toContain('xxx');
  });

  it('несколько внешних событий без evidence дают ОДИН skip на discovery (review I-9)', async () => {
    const db = new FakeCalendarDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.proposals.push({ id: 'pr-a', user_id: account.userId, event: { uid: 'uid-a' } });
    db.proposals.push({ id: 'pr-b', user_id: account.userId, event: { uid: 'uid-b' } });

    const plan = await discoverCalendarDeletion({ db: db as any, account, origin: 'explicit' });

    expect(plan.skips).toEqual([{
      resourceType: 'calendar.external',
      reason: 'owner_unverifiable',
    }]);
  });
});

describe('CalendarAccountDeletionAdapter', () => {
  beforeEach(() => {
    account.userId = 'u-deleted';
  });

  it('calendar failure оставляет connection и retry, global integrations не меняются', async () => {
    const db = new FakeCalendarDb();
    seed(db);
    const beforeFlags = JSON.parse(JSON.stringify(db.integrationFlags));
    const { adapter, calendar } = makeAdapter(db);
    calendar.disconnect.mockRejectedValue({ response: { status: 503 } });

    await expect(adapter.execute(job('calendar.stop', 'yandex'), execution(db)))
      .rejects.toMatchObject({ kind: 'external_5xx' });
    expect(db.connections[0].id).toBe('cal-1');
    expect(db.integrationFlags).toEqual(beforeFlags);
    // Адаптер календаря не запрашивает интеграционные таблицы вообще.
    for (const { sql } of db.queries) {
      expect(sql).not.toContain('integration_flags');
      expect(sql).not.toContain('short_youtube_account');
    }
  });

  it('stop роутит exchange в disconnectExchange и идемпотентен', async () => {
    const db = new FakeCalendarDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    db.connections.push({ id: 'cal-2', user_id: account.userId, provider: 'exchange', enabled: true });
    const { adapter, calendar } = makeAdapter(db);
    const ctx = execution(db);

    await adapter.execute(job('calendar.stop', 'exchange'), ctx);
    await adapter.execute(job('calendar.stop', 'exchange'), ctx);

    expect(calendar.disconnectExchange).toHaveBeenCalledTimes(2);
    expect(calendar.disconnectExchange).toHaveBeenCalledWith(account.userId);
    expect(calendar.disconnect).not.toHaveBeenCalled();
    expect(ctx.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it('disconnect при отсутствии connection — успех, повторный execute не падает', async () => {
    const db = new FakeCalendarDb();
    db.users.set(account.userId, { state: 'deleted', deletionId });
    const { adapter, calendar } = makeAdapter(db);
    const ctx = execution(db);

    await expect(adapter.execute(job('calendar.stop', 'yandex'), ctx)).resolves.toBeUndefined();
    await expect(adapter.execute(job('calendar.stop', 'yandex'), ctx)).resolves.toBeUndefined();
    expect(calendar.disconnect).toHaveBeenCalledTimes(2);
  });

  it('purge удаляет только строки владельца текущего поколения; повтор безопасен', async () => {
    const db = new FakeCalendarDb();
    seed(db);
    db.users.set('u-other', { state: 'active', deletionId: null });
    db.proposals.push({ id: 'pr-other', user_id: 'u-other', event: { uid: 'keep' } });
    db.connections.push({ id: 'cal-other', user_id: 'u-other', provider: 'yandex' });
    db.tripCalendars.push({ user_id: 'u-other', kind: 'outlook', url: 'https://keep.example' });
    db.linkeonTasks.push({ uid: 'lt-other', user_id: 'u-other', title: 'Чужое дело' });
    db.dayFraming.push({ user_id: 'u-other', day: '2026-11-01', kind: 'morning', text: 'чужой фрейм' });
    const { adapter } = makeAdapter(db);
    const ctx = execution(db);

    await adapter.execute(job('calendar.purge', 'calendar'), ctx);
    await adapter.execute(job('calendar.purge', 'calendar'), ctx);

    expect(ctx.assertCurrent).toHaveBeenCalledTimes(2);
    expect(db.proposals.map((row) => row.id)).toEqual(['pr-other']);
    expect(db.connections.map((row) => row.id)).toEqual(['cal-other']);
    expect(db.tripCalendars).toHaveLength(1);
    expect(db.linkeonTasks.map((row) => row.uid)).toEqual(['lt-other']);
    expect(db.dayFraming.map((row) => row.user_id)).toEqual(['u-other']);
  });

  it('после reactivation старый deletionId ничего не удаляет', async () => {
    const db = new FakeCalendarDb();
    seed(db);
    db.users.set(account.userId, { state: 'active', deletionId: 'deletion-new' });
    const { adapter } = makeAdapter(db);

    await adapter.execute(job('calendar.purge', 'calendar'), execution(db));

    expect(db.proposals).toHaveLength(1);
    expect(db.connections).toHaveLength(1);
    expect(db.tripCalendars).toHaveLength(1);
    expect(db.linkeonTasks).toHaveLength(1);
    expect(db.dayFraming).toHaveLength(1);
  });

  it('normalized destructive SQL сам содержит owner/state/deletion predicates', async () => {
    const db = new FakeCalendarDb();
    seed(db);
    const { adapter } = makeAdapter(db);

    await adapter.execute(job('calendar.purge', 'calendar'), execution(db));

    const deletes = db.queries
      .map(({ sql }) => sql.replace(/\s+/g, ' ').trim())
      .filter((sql) => sql.startsWith('DELETE FROM'));
    expect(deletes).toHaveLength(5);
    for (const sql of deletes) {
      expect(sql).toContain('user_id=$1');
      expect(sql).toContain('u.internal_id=$1');
      expect(sql).toContain("u.state='deleted'");
      expect(sql).toContain('u.deletion_id=$2');
    }
  });

  it('регистрируется в существующем Registry без глобального assertReady', () => {
    const db = new FakeCalendarDb();
    const registry = new AccountDeletionRegistry();
    const ready = jest.spyOn(registry, 'assertReady');
    const adapter = new CalendarAccountDeletionAdapter(db as any, makeCalendar() as any, registry);

    adapter.onModuleInit();

    for (const resourceType of ['calendar.stop', 'calendar.purge'] as const) {
      expect(registry.getExecutor(resourceType)).toBe(adapter);
    }
    expect(ready).not.toHaveBeenCalled();
  });

  it('catalog и CalendarModule содержат обязательную wiring', () => {
    expect(DELETION_DISCOVERERS.filter((item) => item === discoverCalendarDeletion)).toHaveLength(1);
    // purge секретов соединений — только после успешной остановки (design spec:
    // «Остановка ... происходит до удаления»).
    expect(DELETION_DEPENDENCIES['calendar.purge']).toEqual({ allOf: ['calendar.stop'] });
    expect(Reflect.getMetadata('providers', CalendarModule)).toContain(CalendarAccountDeletionAdapter);
    expect(Reflect.getMetadata('imports', CalendarModule)).toContain(AccountDeletionModule);
  });
});
