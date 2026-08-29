import { encryptSecret, decryptSecret } from './crypto';
import { overlaps, CalendarService } from './calendar.service';
import { YandexCalDavConnector } from './caldav';

describe('connect() app-password hygiene', () => {
  beforeAll(() => { process.env.CALENDAR_SECRET_KEY = '0123456789abcdef0123456789abcdef'; });
  afterEach(() => jest.restoreAllMocks());
  // Regression: Яндекс показывает пароль приложения группами через пробелы; введённый как есть,
  // он уходил в Basic-auth с пробелами → 401 на «правильном» пароле. connect() должен вырезать ВСЕ пробелы.
  it('strips whitespace from the app-password and trims the username', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new CalendarService(pg as any, {} as any, {} as any, {} as any);
    const testSpy = jest.spyOn(YandexCalDavConnector.prototype, 'test').mockResolvedValue(true);
    jest.spyOn(YandexCalDavConnector.prototype, 'discoverCollection').mockResolvedValue('https://cal.example/');
    jest.spyOn(YandexCalDavConnector.prototype, 'discoverTaskCollection').mockResolvedValue(null);
    const res = await service.connect('userA', 'yandex', '  me@yandex.ru ', 'abcd efgh ijkl mnop');
    expect(res.ok).toBe(true);
    expect(testSpy).toHaveBeenCalledWith(expect.objectContaining({ username: 'me@yandex.ru', appPassword: 'abcdefghijklmnop' }));
  });
});

describe('secret crypto', () => {
  beforeAll(() => { process.env.CALENDAR_SECRET_KEY = '0123456789abcdef0123456789abcdef'; });
  it('round-trips a secret and does not store plaintext', () => {
    const enc = encryptSecret('my-app-password');
    expect(enc).not.toContain('my-app-password');
    expect(decryptSecret(enc)).toBe('my-app-password');
  });
});

describe('overlaps', () => {
  const ev = (at: string, min = 60) => ({ at, end: new Date(new Date(at).getTime() + min * 60000).toISOString(), title: 't', source: 's' });
  it('true when proposed slot intersects an existing event', () => {
    expect(overlaps({ title: 'p', datetime: '2026-07-20T15:00:00' }, ev('2026-07-20T10:00:00Z'), 60)).toBe(true); // 15:00 YEKT == 10:00Z
  });
  it('false when clearly apart', () => {
    expect(overlaps({ title: 'p', datetime: '2026-07-20T20:00:00' }, ev('2026-07-20T10:00:00Z'), 60)).toBe(false);
  });
});

// Security regression (owner requirement): an agent must NEVER write to one user's calendar
// on behalf of another user. createEvent(userId) must resolve creds ONLY via that same userId's
// own row in calendar_connections — never a hardcoded id, never another user's connection.
describe('CalendarService.createEvent — write-scoping (no cross-user writes)', () => {
  it('is scoped to the passed userId and fails closed when that user has no connection', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const talerIdStore = { getConnection: jest.fn().mockResolvedValue(null) };
    const talerIdConnector = { listEvents: jest.fn(), createEvent: jest.fn() };
    const service = new CalendarService(pg as any, talerIdStore as any, talerIdConnector as any, {} as any);

    const result = await service.createEvent('userB', { title: 'x', datetime: '2026-07-20T15:00:00' });

    // No connection for userB -> fail closed, no write attempted.
    expect(result).toEqual({ ok: false, error: 'Календарь не подключён' });
    // The lookup queried calendar_connections scoped to userB's own id — matches creds()'s
    // `SELECT ... FROM calendar_connections WHERE user_id=$1 AND enabled=true LIMIT 1`, [userId].
    expect(pg.query).toHaveBeenCalledWith(expect.stringContaining('calendar_connections'), ['userB']);
  });

  it("never reaches another user's (the owner's) connection while creating an event for userB", async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const talerIdStore = { getConnection: jest.fn().mockResolvedValue(null) };
    const talerIdConnector = { listEvents: jest.fn(), createEvent: jest.fn() };
    const service = new CalendarService(pg as any, talerIdStore as any, talerIdConnector as any, {} as any);

    await service.createEvent('userB', { title: 'x', datetime: '2026-07-20T15:00:00' });

    // '79656445804' stands in for the owner's account (see CLAUDE.md test accounts). The only
    // WHERE-clause param used anywhere during this call must be the caller's own id ('userB') —
    // proving userB's write can never touch the owner's (or anyone else's) row.
    expect(pg.query).not.toHaveBeenCalledWith(expect.anything(), ['79656445804']);
    for (const call of pg.query.mock.calls) {
      expect(call[1]).toEqual(['userB']);
    }
  });
});

// Same write-scoping guarantee for the task (VTODO) surface added in Task 2 — setTaskDone must
// never touch another user's connection either.
describe('CalendarService.setTaskDone — write-scoping (no cross-user writes)', () => {
  it('is scoped to the passed userId and fails closed when that user has no connection', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const talerIdStore = { getConnection: jest.fn().mockResolvedValue(null) };
    const talerIdConnector = { listEvents: jest.fn(), createEvent: jest.fn() };
    const service = new CalendarService(pg as any, talerIdStore as any, talerIdConnector as any, {} as any);

    const result = await service.setTaskDone('userB', 'uid', true);

    // No connection for userB -> fail closed, no write attempted.
    expect(result).toEqual({ ok: false, error: 'Задачи недоступны' });
    // The lookup queried calendar_connections scoped to userB's own id — matches creds()'s
    // `SELECT ... FROM calendar_connections WHERE user_id=$1 AND enabled=true LIMIT 1`, [userId].
    expect(pg.query).toHaveBeenCalledWith(expect.stringContaining('calendar_connections'), ['userB']);
  });

  it("never reaches another user's (the owner's) connection while setting a task done for userB", async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const talerIdStore = { getConnection: jest.fn().mockResolvedValue(null) };
    const talerIdConnector = { listEvents: jest.fn(), createEvent: jest.fn() };
    const service = new CalendarService(pg as any, talerIdStore as any, talerIdConnector as any, {} as any);

    await service.setTaskDone('userB', 'uid', true);

    // '79656445804' stands in for the owner's account (see CLAUDE.md test accounts). The only
    // WHERE-clause param used anywhere during this call must be the caller's own id ('userB') —
    // proving userB's write can never touch the owner's (or anyone else's) row.
    expect(pg.query).not.toHaveBeenCalledWith(expect.anything(), ['79656445804']);
    for (const call of pg.query.mock.calls) {
      expect(call[1]).toEqual(['userB']);
    }
  });
});

describe('createTaskFromProposal — task proposals route to the cloud task home (regression: were created as events)', () => {
  beforeAll(() => { process.env.CALENDAR_SECRET_KEY = '0123456789abcdef0123456789abcdef'; });
  const mk = () => {
    const create = jest.fn().mockResolvedValue({ uid: 'u1' });
    const linkeonTasks = { create };
    const service = new CalendarService(
      { query: jest.fn().mockResolvedValue({ rows: [] }) } as any,
      {} as any, {} as any, linkeonTasks as any,
    );
    return { service, create };
  };
  it('recurring task → ONE linkeon_tasks row with recurrence + TZ anchor (not N events)', async () => {
    const { service, create } = mk();
    const ok = await service.createTaskFromProposal('u', {
      title: 'Уход утро', datetime: '2026-08-30T07:30:00',
      recurrence: { freq: 'daily', until: '2026-11-24' } as any,
    });
    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][1];
    expect(arg.title).toBe('Уход утро');
    expect(arg.recurrence).toEqual({ freq: 'daily', until: '2026-11-24' });
    expect(arg.due).toBe('2026-08-30T07:30:00+05:00');
  });
  it('dates set → one task per date', async () => {
    const { service, create } = mk();
    const ok = await service.createTaskFromProposal('u', { title: 'x', dates: ['2026-09-01T09:00:00', '2026-09-03T09:00:00'] });
    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('plain task with time → single row, due set, no recurrence', async () => {
    const { service, create } = mk();
    await service.createTaskFromProposal('u', { title: 'позвонить', datetime: '2026-09-01T15:00:00' });
    const arg = create.mock.calls[0][1];
    expect(arg.due).toBe('2026-09-01T15:00:00+05:00');
    expect(arg.recurrence).toBeUndefined();
  });
  it('empty title → false, no create', async () => {
    const { service, create } = mk();
    expect(await service.createTaskFromProposal('u', { title: '  ' } as any)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('createTaskRouted — TalerID-connected users write tasks to TalerID (owner: TalerID is default)', () => {
  beforeAll(() => { process.env.CALENDAR_SECRET_KEY = '0123456789abcdef0123456789abcdef'; });
  it('recurring task → talerIdConnector.createTask with recurrence + idempotencyKey; NOT linkeon_tasks', async () => {
    const createTask = jest.fn().mockResolvedValue({ ok: true, uid: 't1' });
    const linkeonCreate = jest.fn();
    const svc = new CalendarService(
      { query: jest.fn().mockResolvedValue({ rows: [] }) } as any,
      { getConnection: jest.fn().mockResolvedValue({ status: 'connected' }) } as any,
      { createTask } as any,
      { create: linkeonCreate } as any,
    );
    const ok = await svc.createTaskFromProposal('u', {
      title: 'Уход утро', datetime: '2026-08-30T07:30:00',
      recurrence: { freq: 'daily', until: '2026-11-24' } as any,
    });
    expect(ok).toBe(true);
    expect(createTask).toHaveBeenCalledTimes(1);
    const arg = createTask.mock.calls[0][1];
    expect(arg.due).toBe('2026-08-30T07:30:00+05:00');
    expect(arg.recurrence).toEqual({ freq: 'daily', until: '2026-11-24' });
    expect(typeof arg.idempotencyKey).toBe('string');
    expect(linkeonCreate).not.toHaveBeenCalled();
  });
  it('TalerID createTask fails → createTaskFromProposal returns false (proposal reverts)', async () => {
    const svc = new CalendarService(
      { query: jest.fn().mockResolvedValue({ rows: [] }) } as any,
      { getConnection: jest.fn().mockResolvedValue({ status: 'connected' }) } as any,
      { createTask: jest.fn().mockResolvedValue({ ok: false }) } as any,
      { create: jest.fn() } as any,
    );
    expect(await svc.createTaskFromProposal('u', { title: 'x', datetime: '2026-09-01T09:00:00' })).toBe(false);
  });
});
