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
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${esc(e.title)}`,
    e.note ? `DESCRIPTION:${esc(e.note)}` : '',
    `DTSTART;TZID=${TZID}:${icsLocal(e.datetime)}`,
    `DTEND;TZID=${TZID}:${icsLocal(endNaive)}`,
    'END:VEVENT',
  ].filter(Boolean).join('\r\n');
}

export class YandexCalDavConnector implements CalendarConnector {
  private calendarUrl(creds: CalendarCreds): string {
    // Yandex default calendar collection for a user.
    return `${creds.baseUrl.replace(/\/$/, '')}/calendars/${encodeURIComponent(creds.username)}/events-default/`;
  }
  private authHeader(creds: CalendarCreds): string {
    return 'Basic ' + Buffer.from(`${creds.username}:${creds.appPassword}`).toString('base64');
  }

  async test(creds: CalendarCreds): Promise<boolean> {
    try {
      const res = await fetch(this.calendarUrl(creds), {
        method: 'PROPFIND',
        headers: { Authorization: this.authHeader(creds), Depth: '0', 'Content-Type': 'application/xml' },
        body: '<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
        signal: AbortSignal.timeout(8000),
      } as any);
      return res.status === 207 || (res.status >= 200 && res.status < 300);
    } catch { return false; }
  }

  async createEvent(creds: CalendarCreds, event: ProposedEvent): Promise<{ uid: string }> {
    const uid = randomUUID();
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Linkeon//trip//RU\r\n${VTIMEZONE_ASIA_YEKATERINBURG}\r\n${buildVEvent(event, uid)}\r\nEND:VCALENDAR\r\n`;
    const res = await fetch(`${this.calendarUrl(creds)}${uid}.ics`, {
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
      const res = await fetch(this.calendarUrl(creds), {
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
