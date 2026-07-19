import * as ical from 'node-ical';
import { randomUUID } from 'crypto';
import { CalendarConnector, CalendarCreds, CalEvent, ProposedEvent } from './calendar.types';

export const YANDEX_CALDAV_BASE = 'https://caldav.yandex.ru';
const TZID = 'Asia/Yekaterinburg';
const OFFSET = '+05:00'; // Russia has no DST

const VTIMEZONE_ASIA_YEKATERINBURG = (
  'BEGIN:VTIMEZONE\r\n' +
  'TZID:Asia/Yekaterinburg\r\n' +
  'BEGIN:STANDARD\r\n' +
  'DTSTART:19700101T000000\r\n' +
  'TZOFFSETFROM:+0500\r\n' +
  'TZOFFSETTO:+0500\r\n' +
  'TZNAME:+05\r\n' +
  'END:STANDARD\r\n' +
  'END:VTIMEZONE'
);

/** Format a naive local datetime "2026-07-20T15:00:00" as an ICS local stamp "20260720T150000". */
function icsLocal(naive: string): string {
  return naive.replace(/[-:]/g, '').replace(/\.\d+$/, '');
}

export function buildVEvent(e: ProposedEvent, uid: string): string {
  const start = new Date(`${e.datetime}${OFFSET}`);
  const end = new Date(start.getTime() + (e.durationMin ?? 60) * 60_000);
  // render end back to naive local wall-clock
  const endNaive = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZID, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(end).replace(' ', 'T');
  const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  // DTSTAMP is REQUIRED by RFC 5545; without it Yandex stores the event but its
  // web/app UI won't render it. CREATED/SEQUENCE/STATUS keep the event well-formed.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `CREATED:${stamp}`,
    `SUMMARY:${esc(e.title)}`,
    e.note ? `DESCRIPTION:${esc(e.note)}` : '',
    `DTSTART;TZID=${TZID}:${icsLocal(e.datetime)}`,
    `DTEND;TZID=${TZID}:${icsLocal(endNaive)}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
  ].filter(Boolean).join('\r\n');
}

/** Trailing integer id of an href's last path segment (e.g. ".../events-9999999/" -> 9999999n), or null if none. */
function trailingId(href: string): bigint | null {
  const seg = href.replace(/\/+$/, '').split('/').pop() || '';
  const m = /(\d+)$/.exec(seg);
  return m ? BigInt(m[1]) : null;
}

/**
 * Numeric-aware href comparator: hrefs whose last path segment ends in digits are ordered
 * ascending by that number (as BigInt, so digit-width doesn't skew the sort — "events-9999999"
 * sorts before "events-10000000" even though lexicographically "1" < "9"). Hrefs without a
 * trailing number sort after all numbered ones, and among themselves lexicographically.
 */
function collectionIdComparator(a: string, b: string): number {
  const na = trailingId(a);
  const nb = trailingId(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return a.localeCompare(b);
}

export class YandexCalDavConnector implements CalendarConnector {
  private calendarHomeUrl(creds: CalendarCreds): string {
    return `${creds.baseUrl.replace(/\/$/, '')}/calendars/${encodeURIComponent(creds.username)}/`;
  }
  private authHeader(creds: CalendarCreds): string {
    return 'Basic ' + Buffer.from(`${creds.username}:${creds.appPassword}`).toString('base64');
  }

  async test(creds: CalendarCreds): Promise<boolean> {
    try {
      const res = await fetch(this.calendarHomeUrl(creds), {
        method: 'PROPFIND',
        headers: { Authorization: this.authHeader(creds), Depth: '0', 'Content-Type': 'application/xml' },
        body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>',
        signal: AbortSignal.timeout(8000),
      } as any);
      return res.status === 207 || (res.status >= 200 && res.status < 300);
    } catch { return false; }
  }

  /**
   * Discover the account's default event collection under the calendar home.
   * Yandex does not expose schedule-default-calendar-URL, so we PROPFIND the
   * home (Depth 1) and pick the lowest-sorted `events-*` collection that
   * supports VEVENT — that's the account's "Мои события" default; secondary
   * calendars (e.g. shared/"Алиса") get higher ids.
   */
  async discoverCollection(creds: CalendarCreds): Promise<string | null> {
    let res: any;
    try {
      res = await fetch(this.calendarHomeUrl(creds), {
        method: 'PROPFIND',
        headers: { Authorization: this.authHeader(creds), Depth: '1', 'Content-Type': 'application/xml' },
        body: '<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><resourcetype/><C:supported-calendar-component-set/></prop></propfind>',
        signal: AbortSignal.timeout(8000),
      } as any);
    } catch { return null; }
    if (res.status !== 207) return null;
    const xml = (await res.text()).replace(/<(\/?)[a-zA-Z0-9]+:/g, '<$1'); // strip ns prefixes
    const hrefs: string[] = [];
    for (const m of xml.matchAll(/<response>([\s\S]*?)<\/response>/g)) {
      const b = m[1];
      // Yandex emits tags WITH attributes: `<href xmlns="DAV:">` and `<calendar xmlns:C="…"/>`,
      // so these matchers must tolerate attributes (bare `<href>`/`<calendar/>` would miss them).
      const href = /<href[^>]*>([^<]*)<\/href>/.exec(b)?.[1];
      const isCalendar = /<calendar[\s/>]/.test(b);
      const hasVevent = /<comp\s+name="VEVENT"/.test(b);
      if (href && isCalendar && hasVevent) hrefs.push(href.trim());
    }
    if (hrefs.length === 0) return null;
    hrefs.sort(collectionIdComparator); // lowest numeric events-<id> = the default personal calendar
    const path = hrefs[0];
    console.debug('caldav discoverCollection: chose', path);
    // return absolute URL (path is server-absolute like /calendars/<user>/events-<id>/)
    const origin = new URL(creds.baseUrl).origin;
    return path.startsWith('http') ? path : origin + path;
  }

  private async resolveCollection(creds: CalendarCreds): Promise<string | null> {
    if (creds.collectionUrl) return creds.collectionUrl;
    // Defensive one-shot fallback if collectionUrl wasn't stored (e.g. legacy connection).
    return this.discoverCollection(creds);
  }

  async createEvent(creds: CalendarCreds, event: ProposedEvent): Promise<{ uid: string }> {
    const collectionUrl = await this.resolveCollection(creds);
    if (!collectionUrl) throw new Error('CalDAV collection not found');
    const uid = randomUUID();
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Linkeon//trip//RU\r\n${VTIMEZONE_ASIA_YEKATERINBURG}\r\n${buildVEvent(event, uid)}\r\nEND:VCALENDAR\r\n`;
    const base = collectionUrl.endsWith('/') ? collectionUrl : `${collectionUrl}/`;
    const res = await fetch(`${base}${uid}.ics`, {
      method: 'PUT',
      headers: { Authorization: this.authHeader(creds), 'Content-Type': 'text/calendar; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(8000),
    } as any);
    if (res.status < 200 || res.status >= 300) throw new Error(`CalDAV PUT failed: ${res.status}`);
    return { uid };
  }

  async listEvents(creds: CalendarCreds, start: Date, end: Date): Promise<CalEvent[]> {
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const report = `<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
      <D:prop><C:calendar-data/></D:prop>
      <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
        <C:time-range start="${fmt(start)}" end="${fmt(end)}"/>
      </C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
    try {
      const collectionUrl = await this.resolveCollection(creds);
      if (!collectionUrl) return [];
      const res = await fetch(collectionUrl, {
        method: 'REPORT',
        headers: { Authorization: this.authHeader(creds), Depth: '1', 'Content-Type': 'application/xml' },
        body: report, signal: AbortSignal.timeout(8000),
      } as any);
      if (res.status !== 207) return [];
      const xml = await res.text();
      const out: CalEvent[] = [];
      for (const m of xml.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)) {
        const parsed: any = ical.parseICS(`BEGIN:VCALENDAR\n${m[0]}\nEND:VCALENDAR`);
        for (const k of Object.keys(parsed)) {
          const ev = parsed[k];
          if (ev?.type === 'VEVENT' && ev.start) {
            const s = new Date(ev.start);
            if (s >= start && s < end) out.push({ at: s.toISOString(), title: String(ev.summary || '').trim() || 'Событие', source: 'yandex', uid: ev.uid });
          }
        }
      }
      return out;
    } catch (e) {
      console.debug('caldav listEvents failed', e);
      return [];
    }
  }
}
