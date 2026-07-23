import { buildVEvent, buildVTodo, YandexCalDavConnector, YANDEX_CALDAV_BASE } from './caldav';

describe('buildVTodo', () => {
  it('builds a VTODO with DTSTAMP, SUMMARY, STATUS and optional DUE', () => {
    const ics = buildVTodo({ title: 'Собрать вещи', datetime: '2026-07-20T09:00:00' }, 'u1', false);
    expect(ics).toContain('BEGIN:VTODO');
    expect(ics).toContain('UID:u1');
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
    expect(ics).toContain('SUMMARY:Собрать вещи');
    expect(ics).toContain('DUE;TZID=Asia/Yekaterinburg:20260720T090000');
    expect(ics).toContain('STATUS:NEEDS-ACTION');
  });
  it('done=true → STATUS:COMPLETED + COMPLETED + PERCENT-COMPLETE:100', () => {
    const ics = buildVTodo({ title: 'X' }, 'u2', true);
    expect(ics).toContain('STATUS:COMPLETED');
    expect(ics).toContain('PERCENT-COMPLETE:100');
    expect(ics).toMatch(/COMPLETED:\d{8}T\d{6}Z/);
  });
});

describe('buildVEvent', () => {
  it('builds a valid VEVENT with DTSTART/DTEND from datetime + duration', () => {
    const ics = buildVEvent(
      { title: 'Синк Триентос', datetime: '2026-07-20T15:00:00', durationMin: 60, note: 'еженедельный' },
      'uid-123',
    );
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:uid-123');
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z/); // required by RFC 5545 or Yandex UI won't render
    expect(ics).toContain('SUMMARY:Синк Триентос');
    expect(ics).toContain('DTSTART;TZID=Asia/Yekaterinburg:20260720T150000');
    expect(ics).toContain('DTEND;TZID=Asia/Yekaterinburg:20260720T160000');
    expect(ics).toContain('END:VEVENT');
  });

  it('defaults duration to 60 min when omitted', () => {
    const ics = buildVEvent({ title: 'X', datetime: '2026-07-20T15:00:00' }, 'u1');
    expect(ics).toContain('DTEND;TZID=Asia/Yekaterinburg:20260720T160000');
  });
});

const HOME_URL = `${YANDEX_CALDAV_BASE}/calendars/u%40yandex.ru/`;
const COLLECTION_URL = `${YANDEX_CALDAV_BASE}/calendars/u%40yandex.ru/events-19201090/`;
const creds = { baseUrl: YANDEX_CALDAV_BASE, username: 'u@yandex.ru', appPassword: 'app-pass', collectionUrl: COLLECTION_URL };

describe('YandexCalDavConnector', () => {
  let calls: any[];
  beforeEach(() => {
    calls = [];
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      calls.push({ url, method: opts?.method, headers: opts?.headers, body: opts?.body });
      if (opts?.method === 'PROPFIND') return { ok: true, status: 207, text: async () => '<multistatus/>' } as any;
      if (opts?.method === 'PUT') return { ok: true, status: 201, text: async () => '' } as any;
      if (opts?.method === 'REPORT') {
        return { ok: true, status: 207, text: async () =>
          `<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
           <response><propstat><prop><C:calendar-data>BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260720T100000Z\nSUMMARY:Существующая\nUID:e1\nEND:VEVENT\nEND:VCALENDAR</C:calendar-data></prop></propstat></response>
           </multistatus>` } as any;
      }
      return { ok: false, status: 404, text: async () => '' } as any;
    });
  });

  it('test() PROPFINDs the calendar home with Basic auth and returns true on 2xx/207', async () => {
    const ok = await new YandexCalDavConnector().test(creds);
    expect(ok).toBe(true);
    expect(calls[0].method).toBe('PROPFIND');
    expect(calls[0].url).toBe(HOME_URL);
    expect(calls[0].headers.Authorization).toMatch(/^Basic /);
  });

  it('createEvent() PUTs an .ics under creds.collectionUrl and returns created:1 + the uid', async () => {
    const r = await new YandexCalDavConnector().createEvent(creds, { title: 'X', datetime: '2026-07-20T15:00:00' });
    expect(r).toEqual({ created: 1, failed: 0, uids: [expect.any(String)] });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.url).toBe(`${COLLECTION_URL}${r.uids[0]}.ics`);
    expect(put.body).toContain('BEGIN:VEVENT');
    expect(put.body).toContain('BEGIN:VTIMEZONE');
    expect(put.body).toContain('TZID:Asia/Yekaterinburg');
  });

  it('listEvents() REPORTs against creds.collectionUrl and parses returned VEVENTs', async () => {
    const evs = await new YandexCalDavConnector().listEvents(creds, new Date('2026-07-18Z'), new Date('2026-07-24Z'));
    expect(evs.map((e) => e.title)).toContain('Существующая');
    const report = calls.find((c) => c.method === 'REPORT');
    expect(report.url).toBe(COLLECTION_URL);
  });

  it('listEvents() resolves to [] when fetch rejects', async () => {
    (global as any).fetch = jest.fn(async () => {
      throw new Error('network down');
    });
    const evs = await new YandexCalDavConnector().listEvents(creds, new Date('2026-07-18Z'), new Date('2026-07-24Z'));
    expect(evs).toEqual([]);
  });

  it('listEvents() populates end (ISO instant) from the VEVENT DTEND when present', async () => {
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      if (opts?.method === 'REPORT') {
        return { ok: true, status: 207, text: async () =>
          `<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
           <response><propstat><prop><C:calendar-data>BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260720T100000Z\nDTEND:20260720T113000Z\nSUMMARY:Синк\nUID:e2\nEND:VEVENT\nEND:VCALENDAR</C:calendar-data></prop></propstat></response>
           </multistatus>` } as any;
      }
      return { ok: false, status: 404, text: async () => '' } as any;
    });
    const evs = await new YandexCalDavConnector().listEvents(creds, new Date('2026-07-18Z'), new Date('2026-07-24Z'));
    const sync = evs.find((e) => e.uid === 'e2');
    // 90-minute event — asserting a real end proves conflict-overlap logic no longer has to
    // fall back to the 1h default (the bug this test guards against).
    expect(sync?.end).toBe('2026-07-20T11:30:00.000Z');
  });

  it('listEvents() resolves to [] when res.text() rejects', async () => {
    (global as any).fetch = jest.fn(async () => {
      return { ok: true, status: 207, text: async () => { throw new Error('stream error'); } } as any;
    });
    const evs = await new YandexCalDavConnector().listEvents(creds, new Date('2026-07-18Z'), new Date('2026-07-24Z'));
    expect(evs).toEqual([]);
  });
});

describe('YandexCalDavConnector.discoverCollection', () => {
  const credsNoCollection = { baseUrl: YANDEX_CALDAV_BASE, username: 'u@yandex.ru', appPassword: 'app-pass' };

  it('parses a multistatus with two events-* VEVENT calendars + a todos collection, returns the lowest-id events collection absolute URL', async () => {
    const multistatus = `<?xml version="1.0"?>
      <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:response>
          <href xmlns="DAV:">/calendars/u%40yandex.ru/events-34526171/</href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
        <D:response>
          <href xmlns="DAV:">/calendars/u%40yandex.ru/events-19201090/</href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
        <D:response>
          <href xmlns="DAV:">/calendars/u%40yandex.ru/todos-1/</href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
      </D:multistatus>`;
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      expect(opts.method).toBe('PROPFIND');
      expect(opts.headers.Depth).toBe('1');
      expect(url).toBe(HOME_URL);
      return { ok: true, status: 207, text: async () => multistatus } as any;
    });
    const result = await new YandexCalDavConnector().discoverCollection(credsNoCollection);
    expect(result).toBe(`${YANDEX_CALDAV_BASE}/calendars/u%40yandex.ru/events-19201090/`);
  });

  it('picks the numerically-lowest events-* collection across digit-width boundaries (events-9999999 < events-10000000)', async () => {
    const multistatus = `<?xml version="1.0"?>
      <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:response>
          <href xmlns="DAV:">/calendars/u%40yandex.ru/events-10000000/</href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
        <D:response>
          <href xmlns="DAV:">/calendars/u%40yandex.ru/events-9999999/</href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
      </D:multistatus>`;
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      expect(opts.method).toBe('PROPFIND');
      expect(url).toBe(HOME_URL);
      return { ok: true, status: 207, text: async () => multistatus } as any;
    });
    const result = await new YandexCalDavConnector().discoverCollection(credsNoCollection);
    // Lexicographic sort would wrongly pick "events-10000000" ('1' < '9'); numeric sort must pick events-9999999.
    expect(result).toBe(`${YANDEX_CALDAV_BASE}/calendars/u%40yandex.ru/events-9999999/`);
  });

  it('returns null when PROPFIND does not return 207', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => '' } as any));
    const result = await new YandexCalDavConnector().discoverCollection(credsNoCollection);
    expect(result).toBeNull();
  });

  it('returns null when fetch rejects', async () => {
    (global as any).fetch = jest.fn(async () => { throw new Error('network down'); });
    const result = await new YandexCalDavConnector().discoverCollection(credsNoCollection);
    expect(result).toBeNull();
  });
});

const TASK_COLLECTION_URL = `${YANDEX_CALDAV_BASE}/calendars/u%40yandex.ru/todos-7415896/`;
const credsWithTasks = { ...creds, taskCollectionUrl: TASK_COLLECTION_URL };

describe('YandexCalDavConnector tasks', () => {
  let calls: any[];
  beforeEach(() => {
    calls = [];
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      calls.push({ url, method: opts?.method, headers: opts?.headers, body: opts?.body });
      if (opts?.method === 'PUT') return { ok: true, status: 201, text: async () => '' } as any;
      if (opts?.method === 'GET') {
        return { ok: true, status: 200, text: async () =>
          'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:t1\r\nDTSTAMP:20260719T100000Z\r\nSUMMARY:Купить билеты\r\nDUE;TZID=Asia/Yekaterinburg:20260720T090000\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR' } as any;
      }
      if (opts?.method === 'REPORT') {
        return { ok: true, status: 207, text: async () =>
          `<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
           <response><propstat><prop><C:calendar-data>BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:t1\nSUMMARY:Купить билеты\nDUE;TZID=Asia/Yekaterinburg:20260720T090000\nSTATUS:NEEDS-ACTION\nEND:VTODO\nEND:VCALENDAR</C:calendar-data></prop></propstat></response>
           <response><propstat><prop><C:calendar-data>BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:t2\nSUMMARY:Сделано\nSTATUS:COMPLETED\nEND:VTODO\nEND:VCALENDAR</C:calendar-data></prop></propstat></response>
           </multistatus>` } as any;
      }
      return { ok: false, status: 404, text: async () => '' } as any;
    });
  });

  it('createTask() PUTs a VTODO under creds.taskCollectionUrl and returns the uid', async () => {
    const r = await new YandexCalDavConnector().createTask(credsWithTasks, { title: 'Собрать вещи', datetime: '2026-07-20T09:00:00' });
    expect(r.uid).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.url).toBe(`${TASK_COLLECTION_URL}${r.uid}.ics`);
    expect(put.body).toContain('BEGIN:VTODO');
    expect(put.body).toContain('STATUS:NEEDS-ACTION');
  });

  it('createTask() throws when PUT is not 2xx', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => '' } as any));
    await expect(
      new YandexCalDavConnector().createTask(credsWithTasks, { title: 'X' }),
    ).rejects.toThrow();
  });

  it('listTasks() REPORTs against creds.taskCollectionUrl and parses VTODOs incl. done from STATUS:COMPLETED', async () => {
    const tasks = await new YandexCalDavConnector().listTasks(credsWithTasks, new Date('2026-07-18Z'), new Date('2026-07-24Z'));
    const report = calls.find((c) => c.method === 'REPORT');
    expect(report.url).toBe(TASK_COLLECTION_URL);
    expect(tasks.find((t) => t.uid === 't1')).toMatchObject({ title: 'Купить билеты', done: false });
    expect(tasks.find((t) => t.uid === 't2')).toMatchObject({ title: 'Сделано', done: true });
  });

  it('listTasks() normalizes basic-format DUE;TZID=Asia/Yekaterinburg to an ISO instant (not the raw ICS stamp)', async () => {
    const tasks = await new YandexCalDavConnector().listTasks(credsWithTasks, new Date('2026-07-18Z'), new Date('2026-07-24Z'));
    const t1 = tasks.find((t) => t.uid === 't1');
    // Raw ICS stamp "20260720T090000" would produce NaN via `new Date(due+"+05:00")` if left
    // unconverted — assert it's a real ISO instant: 09:00 Yekaterinburg (+05:00) == 04:00 UTC.
    expect(t1?.due).toBe('2026-07-20T04:00:00.000Z');
    expect(new Date(t1!.due!).getTime()).not.toBeNaN();
  });

  it('listTasks() resolves to [] when fetch rejects', async () => {
    (global as any).fetch = jest.fn(async () => { throw new Error('network down'); });
    const tasks = await new YandexCalDavConnector().listTasks(credsWithTasks, new Date('2026-07-18Z'), new Date('2026-07-24Z'));
    expect(tasks).toEqual([]);
  });

  it('setTaskDone() GETs current VTODO, re-PUTs with STATUS:COMPLETED preserving title/due, returns true on 2xx', async () => {
    const ok = await new YandexCalDavConnector().setTaskDone(credsWithTasks, 't1', true);
    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.url).toBe(`${TASK_COLLECTION_URL}t1.ics`);
    expect(put.body).toContain('SUMMARY:Купить билеты');
    expect(put.body).toContain('STATUS:COMPLETED');
    expect(put.body).toContain('DUE;TZID=Asia/Yekaterinburg:20260720T090000');
  });

  it('setTaskDone() returns false when GET fails', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => '' } as any));
    const ok = await new YandexCalDavConnector().setTaskDone(credsWithTasks, 'missing', true);
    expect(ok).toBe(false);
  });

  it('setTaskDone() returns false when fetch rejects', async () => {
    (global as any).fetch = jest.fn(async () => { throw new Error('network down'); });
    const ok = await new YandexCalDavConnector().setTaskDone(credsWithTasks, 't1', true);
    expect(ok).toBe(false);
  });
});

describe('YandexCalDavConnector.discoverTaskCollection', () => {
  const credsNoCollection = { baseUrl: YANDEX_CALDAV_BASE, username: 'u@yandex.ru', appPassword: 'app-pass' };

  it('parses a multistatus with a VTODO todos-* collection amongst VEVENT calendars, returns absolute URL', async () => {
    const multistatus = `<?xml version="1.0"?>
      <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:response>
          <href xmlns="DAV:">/calendars/u%40yandex.ru/events-19201090/</href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
        <D:response>
          <href xmlns="DAV:">/calendars/u%40yandex.ru/todos-7415896/</href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
      </D:multistatus>`;
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      expect(opts.method).toBe('PROPFIND');
      expect(url).toBe(HOME_URL);
      return { ok: true, status: 207, text: async () => multistatus } as any;
    });
    const result = await new YandexCalDavConnector().discoverTaskCollection(credsNoCollection);
    expect(result).toBe(`${YANDEX_CALDAV_BASE}/calendars/u%40yandex.ru/todos-7415896/`);
  });

  it('returns null when PROPFIND does not return 207', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => '' } as any));
    const result = await new YandexCalDavConnector().discoverTaskCollection(credsNoCollection);
    expect(result).toBeNull();
  });

  it('returns null when fetch rejects', async () => {
    (global as any).fetch = jest.fn(async () => { throw new Error('network down'); });
    const result = await new YandexCalDavConnector().discoverTaskCollection(credsNoCollection);
    expect(result).toBeNull();
  });
});
