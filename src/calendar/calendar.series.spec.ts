import { YandexCalDavConnector, YANDEX_CALDAV_BASE } from './caldav';
import { CalendarService } from './calendar.service';

const COLLECTION_URL = `${YANDEX_CALDAV_BASE}/calendars/u%40yandex.ru/events-19201090/`;
const creds = { baseUrl: YANDEX_CALDAV_BASE, username: 'u@yandex.ru', appPassword: 'app-pass', collectionUrl: COLLECTION_URL };

describe('YandexCalDavConnector.createEvent — series writer', () => {
  let calls: any[];
  beforeEach(() => {
    calls = [];
  });

  it('recurrence: makes exactly 1 PUT whose body contains RRULE, returns created:1', async () => {
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      calls.push({ url, method: opts?.method, body: opts?.body });
      if (opts?.method === 'PUT') return { ok: true, status: 201, text: async () => '' } as any;
      return { ok: false, status: 404, text: async () => '' } as any;
    });
    const r = await new YandexCalDavConnector().createEvent(creds as any, {
      title: 'Отвезти Эдика', datetime: '2026-08-17T09:45:00', durationMin: 60,
      recurrence: { freq: 'weekly', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], count: 10 },
    } as any);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toContain('RRULE:FREQ=WEEKLY');
    expect(r).toEqual({ created: 1, failed: 0, uids: [expect.any(String)] });
  });

  it('dates:[3 dates] → 3 PUTs, created:3, 3 uids', async () => {
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      calls.push({ url, method: opts?.method, body: opts?.body });
      if (opts?.method === 'PUT') return { ok: true, status: 201, text: async () => '' } as any;
      return { ok: false, status: 404, text: async () => '' } as any;
    });
    const r = await new YandexCalDavConnector().createEvent(creds as any, {
      title: 'Тренировка', durationMin: 60,
      dates: ['2026-08-17T09:00:00', '2026-08-19T09:00:00', '2026-08-21T09:00:00'],
    } as any);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(3);
    expect(r.created).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.uids).toHaveLength(3);
    // uids must be unique per PUT
    expect(new Set(r.uids).size).toBe(3);
  });

  it('one PUT returns 500 among dates:[3] → created:2, failed:1', async () => {
    let putCount = 0;
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      calls.push({ url, method: opts?.method, body: opts?.body });
      if (opts?.method === 'PUT') {
        putCount++;
        if (putCount === 2) return { ok: false, status: 500, text: async () => 'boom' } as any;
        return { ok: true, status: 201, text: async () => '' } as any;
      }
      return { ok: false, status: 404, text: async () => '' } as any;
    });
    const r = await new YandexCalDavConnector().createEvent(creds as any, {
      title: 'Тренировка', durationMin: 60,
      dates: ['2026-08-17T09:00:00', '2026-08-19T09:00:00', '2026-08-21T09:00:00'],
    } as any);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(3); // loop must not abort on the failed PUT
    expect(r.created).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.uids).toHaveLength(2);
    expect(r.error).toBeTruthy();
  });

  it('single datetime (no recurrence/dates): 1 PUT, created:1 (unchanged behaviour)', async () => {
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      calls.push({ url, method: opts?.method, body: opts?.body });
      if (opts?.method === 'PUT') return { ok: true, status: 201, text: async () => '' } as any;
      return { ok: false, status: 404, text: async () => '' } as any;
    });
    const r = await new YandexCalDavConnector().createEvent(creds as any, { title: 'X', datetime: '2026-08-17T09:00:00' } as any);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(r).toEqual({ created: 1, failed: 0, uids: [expect.any(String)] });
  });
});

describe('CalendarService.createEvent — wraps the series writer', () => {
  it('ok=true and onWrite fired when created>0, even with partial failure', async () => {
    const pg = {
      query: jest.fn().mockResolvedValue({
        rows: [{ base_url: YANDEX_CALDAV_BASE, username: 'u@yandex.ru', secret_enc: '', collection_url: COLLECTION_URL, todo_collection_url: null }],
      }),
    };
    const service = new CalendarService(pg as any);
    jest.spyOn(require('./crypto'), 'decryptSecret').mockReturnValue('app-pass');
    const onWrite = jest.fn();
    service.onWrite = onWrite;
    (service as any).connector.createEvent = jest.fn().mockResolvedValue({ created: 2, failed: 1, uids: ['a', 'b'], error: 'CalDAV PUT failed: 500' });

    const r = await service.createEvent('u1', { title: 'X', dates: ['2026-08-17T09:00:00', '2026-08-19T09:00:00', '2026-08-21T09:00:00'] } as any);
    expect(r).toEqual({ ok: true, created: 2, failed: 1, uids: ['a', 'b'], error: 'CalDAV PUT failed: 500' });
    expect(onWrite).toHaveBeenCalledWith('u1');
  });

  it('ok=false when created=0 (total failure), no cache bust', async () => {
    const pg = {
      query: jest.fn().mockResolvedValue({
        rows: [{ base_url: YANDEX_CALDAV_BASE, username: 'u@yandex.ru', secret_enc: '', collection_url: COLLECTION_URL, todo_collection_url: null }],
      }),
    };
    const service = new CalendarService(pg as any);
    jest.spyOn(require('./crypto'), 'decryptSecret').mockReturnValue('app-pass');
    const onWrite = jest.fn();
    service.onWrite = onWrite;
    (service as any).connector.createEvent = jest.fn().mockResolvedValue({ created: 0, failed: 1, uids: [], error: 'CalDAV PUT failed: 500' });

    const r = await service.createEvent('u1', { title: 'X', datetime: '2026-08-17T09:00:00' } as any);
    expect(r).toEqual({ ok: false, created: 0, failed: 1, uids: [], error: 'CalDAV PUT failed: 500' });
    expect(onWrite).not.toHaveBeenCalled();
  });
});

describe('CalendarService.findConflicts — series-aware', () => {
  it('finds an overlap that only occurs at a LATER occurrence (occ #5), not occ #0', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new CalendarService(pg as any);
    // Weekly MO-FR count:10 from Mon 2026-08-17 09:45 → occ[5] = 2026-08-24T09:45:00 (per recurrence.spec fixture)
    const event = {
      title: 'Отвезти Эдика', datetime: '2026-08-17T09:45:00', durationMin: 60,
      recurrence: { freq: 'weekly', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], count: 10 },
    } as any;
    // Existing event that overlaps ONLY occ #5 (2026-08-24T09:45 Yekaterinburg == 2026-08-24T04:45Z)
    const existing = { at: '2026-08-24T04:45:00.000Z', end: '2026-08-24T05:45:00.000Z', title: 'Дантист', source: 'yandex', uid: 'ex-1' };
    (service as any).listEvents = jest.fn().mockResolvedValue([existing]);

    const conflicts = await service.findConflicts('u1', event);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].uid).toBe('ex-1');
    // Exactly one listEvents call across the whole series (single window), not one per occurrence.
    expect((service as any).listEvents).toHaveBeenCalledTimes(1);
  });

  it('returns [] when expandOccurrences yields nothing (no datetime/recurrence/dates)', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new CalendarService(pg as any);
    (service as any).listEvents = jest.fn().mockResolvedValue([]);
    const conflicts = await service.findConflicts('u1', { title: 'X' } as any);
    expect(conflicts).toEqual([]);
    expect((service as any).listEvents).not.toHaveBeenCalled();
  });

  it('dedups matches across occurrences by uid', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new CalendarService(pg as any);
    const event = { title: 'Ежедневная встреча', datetime: '2026-08-17T09:00:00', durationMin: 60, recurrence: { freq: 'daily', count: 3 } } as any;
    // A single recurring existing event whose window happens to overlap the proposed slot
    // representation identically on repeated checks — should still count once.
    const existing = { at: '2026-08-17T04:00:00.000Z', end: '2026-08-17T05:00:00.000Z', title: 'Дубль', source: 'yandex', uid: 'dup-1' };
    (service as any).listEvents = jest.fn().mockResolvedValue([existing]);
    const conflicts = await service.findConflicts('u1', event);
    expect(conflicts).toHaveLength(1);
  });
});

describe('CalendarService.saveProposal — anti-duplicate window', () => {
  it('returns the existing id (no INSERT) when an identical proposal was saved within 10s', async () => {
    const query = jest.fn(async (sql: string) => {
      if (/SELECT id FROM calendar_proposals/.test(sql)) return { rows: [{ id: 'existing-id' }] };
      return { rows: [] };
    });
    const pg = { query };
    const service = new CalendarService(pg as any);
    const event = { title: 'X', datetime: '2026-08-17T09:00:00' } as any;
    const id = await service.saveProposal('u1', event, true, []);
    expect(id).toBe('existing-id');
    expect(query.mock.calls.filter(([sql]) => /INSERT INTO calendar_proposals/.test(sql))).toHaveLength(0);
  });

  it('inserts a new proposal when no recent duplicate exists', async () => {
    const query = jest.fn(async (sql: string) => {
      if (/SELECT id FROM calendar_proposals/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const pg = { query };
    const service = new CalendarService(pg as any);
    const event = { title: 'X', datetime: '2026-08-17T09:00:00' } as any;
    const id = await service.saveProposal('u1', event, true, []);
    expect(typeof id).toBe('string');
    expect(query.mock.calls.filter(([sql]) => /INSERT INTO calendar_proposals/.test(sql))).toHaveLength(1);
  });
});

describe('CalendarService.getProposal — occurrenceCount/firstAt/lastAt', () => {
  it('computes occurrenceCount/firstAt/lastAt via expandOccurrences for a recurring proposal', async () => {
    const row = {
      event: { title: 'Отвезти Эдика', datetime: '2026-08-17T09:45:00', recurrence: { freq: 'weekly', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], count: 10 } },
      connected: true,
      conflicts: [],
      kind: 'event',
    };
    const pg = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    const service = new CalendarService(pg as any);
    const p = await service.getProposal('u1', 'id1');
    expect(p?.occurrenceCount).toBe(10);
    expect(p?.firstAt).toBe('2026-08-17T09:45:00');
    expect(p?.lastAt).toBe('2026-08-28T09:45:00');
  });

  it('single-datetime proposal → occurrenceCount:1, firstAt===lastAt', async () => {
    const row = { event: { title: 'X', datetime: '2026-08-17T09:00:00' }, connected: false, conflicts: [], kind: 'event' };
    const pg = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    const service = new CalendarService(pg as any);
    const p = await service.getProposal('u1', 'id1');
    expect(p?.occurrenceCount).toBe(1);
    expect(p?.firstAt).toBe('2026-08-17T09:00:00');
    expect(p?.lastAt).toBe('2026-08-17T09:00:00');
  });

  it('returns null when no row found', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new CalendarService(pg as any);
    const p = await service.getProposal('u1', 'missing');
    expect(p).toBeNull();
  });
});
