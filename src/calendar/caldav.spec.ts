import { buildVEvent, YandexCalDavConnector, YANDEX_CALDAV_BASE } from './caldav';

describe('buildVEvent', () => {
  it('builds a valid VEVENT with DTSTART/DTEND from datetime + duration', () => {
    const ics = buildVEvent(
      { title: 'Синк Триентос', datetime: '2026-07-20T15:00:00', durationMin: 60, note: 'еженедельный' },
      'uid-123',
    );
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:uid-123');
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

  it('createEvent() PUTs an .ics under creds.collectionUrl and returns the uid', async () => {
    const r = await new YandexCalDavConnector().createEvent(creds, { title: 'X', datetime: '2026-07-20T15:00:00' });
    expect(r.uid).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.url).toBe(`${COLLECTION_URL}${r.uid}.ics`);
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
          <D:href>/calendars/u%40yandex.ru/events-34526171/</D:href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
        <D:response>
          <D:href>/calendars/u%40yandex.ru/events-19201090/</D:href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
          </D:prop></D:propstat>
        </D:response>
        <D:response>
          <D:href>/calendars/u%40yandex.ru/todos-1/</D:href>
          <D:propstat><D:prop>
            <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
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
