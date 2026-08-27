import * as ical from 'node-ical';
import { randomUUID } from 'crypto';
import { CalendarConnector, CalendarCreds, CalEvent, ProposedEvent, ProposedTask, Task } from './calendar.types';

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

/**
 * Convert an ICS basic-format value (as extracted from a DUE/DTSTART line, i.e. WITHOUT the
 * leading `;TZID=...` param — already stripped by the caller's regex) into an ISO instant string.
 * Two shapes seen in the wild:
 *  - `20260720T090000` — basic local wall-clock. We only ever write these with
 *    `TZID=Asia/Yekaterinburg` (see buildVEvent/buildVTodo), so read them back with the same
 *    fixed +05:00 offset (Russia has no DST).
 *  - `20260720T090000Z` — already UTC (trailing Z per RFC 5545 form 2).
 * Returns undefined if the value doesn't match the expected basic shape.
 */
function basicToIso(raw: string): string | undefined {
  const isUtc = raw.endsWith('Z');
  const basic = isUtc ? raw.slice(0, -1) : raw;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(basic);
  if (!m) return undefined;
  const naive = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const d = new Date(isUtc ? `${naive}Z` : `${naive}${OFFSET}`);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Build an RFC 5545 RRULE value (without the `RRULE:` prefix) from a Recurrence.
 * Order matters for the test fixtures / readability: FREQ, [INTERVAL], [BYDAY], then exactly
 * one of COUNT/UNTIL. `until` is a naive local date ("YYYY-MM-DD") rendered as an inclusive
 * end-of-day UTC stamp (`YYYYMMDDT235959Z`) per the local Asia/Yekaterinburg offset.
 */
function buildRRule(r: ProposedEvent['recurrence']): string {
  const parts = [`FREQ=${r!.freq.toUpperCase()}`];
  if (r!.interval && r!.interval > 1) parts.push(`INTERVAL=${r!.interval}`);
  if (r!.freq === 'weekly' && r!.byDay && r!.byDay.length > 0) parts.push(`BYDAY=${r!.byDay.join(',')}`);
  if (r!.count) {
    parts.push(`COUNT=${r!.count}`);
  } else if (r!.until) {
    // Per plan: end-of-day UTC-stamp form, i.e. the naive local date's 23:59:59 with a literal
    // `Z` suffix — NOT a real Asia/Yekaterinburg->UTC conversion (RRULE UNTIL just needs to be
    // an unambiguous inclusive bound; Yandex accepts this form).
    parts.push(`UNTIL=${r!.until.replace(/-/g, '')}T235959Z`);
  }
  return parts.join(';');
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
    e.recurrence ? `RRULE:${buildRRule(e.recurrence)}` : '',
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
  ].filter(Boolean).join('\r\n');
}

/** Build a VTODO block. DTSTAMP is REQUIRED (RFC 5545) — Yandex stores it but won't render without it. */
export function buildVTodo(t: { title: string; datetime?: string; note?: string }, uid: string, done: boolean): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VTODO', `UID:${uid}`, `DTSTAMP:${stamp}`, `SUMMARY:${esc(t.title)}`,
    t.note ? `DESCRIPTION:${esc(t.note)}` : '',
    t.datetime ? `DUE;TZID=${TZID}:${icsLocal(t.datetime)}` : '',
    done ? 'STATUS:COMPLETED' : 'STATUS:NEEDS-ACTION',
    done ? 'PERCENT-COMPLETE:100' : '',
    done ? `COMPLETED:${stamp}` : '',
    'END:VTODO',
  ];
  return lines.filter(Boolean).join('\r\n');
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
    // Default WRITE target = lowest-numbered events-<id> (account's «Мои события»).
    return (await this.discoverAllCollections(creds))[0] ?? null;
  }

  /**
   * ALL of the account's VEVENT collections, sorted (default first) [multi-calendar read fix].
   * discoverCollection picked only the lowest-id calendar, so events living in ANY other calendar
   * (рабочий, «Алиса», shared, второй личный) were invisible in the co-pilot even though they
   * exist. listEvents now reads the union across all of these; createEvent still writes to [0].
   */
  async discoverAllCollections(creds: CalendarCreds): Promise<string[]> {
    let res: any;
    try {
      res = await fetch(this.calendarHomeUrl(creds), {
        method: 'PROPFIND',
        headers: { Authorization: this.authHeader(creds), Depth: '1', 'Content-Type': 'application/xml' },
        body: '<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><resourcetype/><C:supported-calendar-component-set/></prop></propfind>',
        signal: AbortSignal.timeout(8000),
      } as any);
    } catch { return []; }
    if (res.status !== 207) return [];
    // Чтение тела тоже под catch, как и сам fetch выше. Соединение может
    // оборваться уже после того, как пришли заголовки, — тогда res.text()
    // реджектится, и без этого ошибка вылетала наружу вместо пустого списка.
    let xml: string;
    try {
      xml = (await res.text()).replace(/<(\/?)[a-zA-Z0-9]+:/g, '<$1'); // strip ns prefixes
    } catch { return []; }
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
    if (hrefs.length === 0) return [];
    hrefs.sort(collectionIdComparator); // lowest numeric events-<id> = the default personal calendar
    const origin = new URL(creds.baseUrl).origin;
    return hrefs.map((h) => (h.startsWith('http') ? h : origin + h));
  }

  private async resolveCollection(creds: CalendarCreds): Promise<string | null> {
    if (creds.collectionUrl) return creds.collectionUrl;
    // Defensive one-shot fallback if collectionUrl wasn't stored (e.g. legacy connection).
    return this.discoverCollection(creds);
  }

  /**
   * PUT a single VEVENT (already fully built, e.g. carrying its own RRULE) under `base` with a
   * fresh uid. Never throws — network/HTTP failures are reported via the returned `error` so the
   * series writer below can continue past a single bad PUT instead of aborting the whole batch.
   */
  private async putVEvent(creds: CalendarCreds, base: string, event: ProposedEvent, uid: string): Promise<{ ok: boolean; error?: string }> {
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Linkeon//trip//RU\r\n${VTIMEZONE_ASIA_YEKATERINBURG}\r\n${buildVEvent(event, uid)}\r\nEND:VCALENDAR\r\n`;
    try {
      const res = await fetch(`${base}${uid}.ics`, {
        method: 'PUT',
        headers: { Authorization: this.authHeader(creds), 'Content-Type': 'text/calendar; charset=utf-8' },
        body,
        signal: AbortSignal.timeout(8000),
      } as any);
      if (res.status < 200 || res.status >= 300) return { ok: false, error: `CalDAV PUT failed: ${res.status}` };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'CalDAV PUT failed' };
    }
  }

  /**
   * Удалить событие по uid: DELETE ресурса `${collectionUrl}${uid}.ics` [удаление 2026-07-29].
   * Best-effort — надёжно работает для событий, СОЗДАННЫХ Линкеоном (мы кладём их как `<uid>.ics`).
   * Для событий, заведённых во внешнем UI (href ≠ uid.ics) или повторов может не совпасть — тогда
   * вернём ok:false, лаунчер честно покажет «не удалось». 404 трактуем как успех (уже нет).
   */
  async deleteEvent(creds: CalendarCreds, uid: string): Promise<{ ok: boolean; error?: string }> {
    const base = creds.collectionUrl;
    if (!base) return { ok: false, error: 'Календарь не подключён' };
    // Синтетический uid повтора вида "<uid>-<occMs>" → берём базовый uid ресурса.
    const resourceUid = uid.replace(/-\d{10,}$/, '');
    try {
      const res = await fetch(`${base}${resourceUid}.ics`, {
        method: 'DELETE',
        headers: { Authorization: this.authHeader(creds) },
        signal: AbortSignal.timeout(8000),
      } as any);
      if (res.status === 404) return { ok: true }; // уже удалено
      if (res.status < 200 || res.status >= 300) return { ok: false, error: `CalDAV DELETE failed: ${res.status}` };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'CalDAV DELETE failed' };
    }
  }

  /**
   * Write one or many VEVENTs depending on the shape of `event`:
   *  - `event.recurrence` set → ONE VEVENT carrying the RRULE (buildVEvent already renders it) →
   *    one PUT. The whole series lives in a single ICS resource.
   *  - `event.dates` set (no recurrence) → one independent VEVENT + PUT per date. Partial success
   *    is allowed and expected — a single bad PUT must not abort the remaining dates.
   *  - neither → today's plain single-occurrence behaviour (one VEVENT, one PUT).
   */
  async createEvent(creds: CalendarCreds, event: ProposedEvent): Promise<{ created: number; failed: number; uids: string[]; error?: string }> {
    const collectionUrl = await this.resolveCollection(creds);
    if (!collectionUrl) throw new Error('CalDAV collection not found');
    const base = collectionUrl.endsWith('/') ? collectionUrl : `${collectionUrl}/`;

    if (event.dates && event.dates.length > 0) {
      let created = 0;
      let failed = 0;
      let error: string | undefined;
      const uids: string[] = [];
      // Cap defensively: the chat tool validates dates ≤ 100, but the REST write endpoint takes
      // the body raw — never fire an unbounded run of sequential CalDAV PUTs.
      for (const d of event.dates.slice(0, 100)) {
        const uid = randomUUID();
        const single: ProposedEvent = { ...event, datetime: d, recurrence: undefined, dates: undefined };
        const r = await this.putVEvent(creds, base, single, uid);
        if (r.ok) { created++; uids.push(uid); } else { failed++; error = r.error; }
      }
      return { created, failed, uids, error };
    }

    // Single VEVENT covers both the recurrence case (RRULE inside) and the plain single-occurrence case.
    const uid = randomUUID();
    const r = await this.putVEvent(creds, base, event, uid);
    return r.ok ? { created: 1, failed: 0, uids: [uid] } : { created: 0, failed: 1, uids: [], error: r.error };
  }

  async listEvents(creds: CalendarCreds, start: Date, end: Date): Promise<CalEvent[]> {
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const report = `<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
      <D:prop><C:calendar-data/></D:prop>
      <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
        <C:time-range start="${fmt(start)}" end="${fmt(end)}"/>
      </C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
    // Read across ALL of the account's calendars, not just the default [multi-calendar fix]:
    // the user's meetings live in whichever calendar they use, not necessarily events-<lowest>.
    let collections = await this.discoverAllCollections(creds);
    if (collections.length === 0) {
      const one = await this.resolveCollection(creds); // fallback: stored/default
      if (one) collections = [one]; else return [];
    }
    const perCollection = await Promise.all(
      collections.map((url) => this.reportEvents(creds, url, report, start, end).catch(() => [] as CalEvent[])),
    );
    // Union + dedup by uid (a single event can't legitimately appear twice, but be safe).
    const seen = new Set<string>();
    const out: CalEvent[] = [];
    for (const arr of perCollection) {
      for (const ev of arr) {
        const key = ev.uid || `${ev.title}|${ev.at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ev);
      }
    }
    return out;
  }

  /** REPORT one VEVENT collection over the window and parse it into CalEvents. */
  private async reportEvents(creds: CalendarCreds, collectionUrl: string, report: string, start: Date, end: Date): Promise<CalEvent[]> {
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
        if (ev?.type !== 'VEVENT' || !ev.start) continue;
        const title = String(ev.summary || '').trim() || 'Событие';
        const startMs = new Date(ev.start).getTime();
        const durationMs = ev.end ? new Date(ev.end).getTime() - startMs : 3_600_000;
        if (ev.rrule) {
          // ПОВТОРЯЮЩЕЕСЯ: у master-VEVENT DTSTART обычно В ПРОШЛОМ (напр. еженедельный синк с
          // февраля). Фильтровать по нему = выкинуть КАЖДУЮ повторяющуюся встречу (это и был баг
          // «календарь пуст»). Разворачиваем rrule и берём вхождения, попадающие в окно.
          let occurrences: Date[] = [];
          try { occurrences = ev.rrule.between(start, end, true); } catch { occurrences = []; }
          const exdates = ev.exdate
            ? new Set(Object.keys(ev.exdate).map((x: string) => new Date(ev.exdate[x]).getTime()))
            : new Set<number>();
          for (const occ of occurrences) {
            const occMs = occ.getTime();
            if (exdates.has(occMs)) continue;
            out.push({ at: new Date(occMs).toISOString(), title, source: 'yandex', uid: `${ev.uid}-${occMs}`, end: new Date(occMs + durationMs).toISOString() });
          }
        } else {
          const s = new Date(startMs);
          if (s >= start && s < end) {
            const item: CalEvent = { at: s.toISOString(), title, source: 'yandex', uid: ev.uid };
            if (ev.end) item.end = new Date(ev.end).toISOString();
            out.push(item);
          }
        }
      }
    }
    return out;
  }

  /**
   * Discover the account's default task (VTODO) collection under the calendar home.
   * Mirrors discoverCollection but filters on VTODO support and picks the lowest-sorted
   * `todos-*` collection — that's the account's "Мои дела" default.
   */
  async discoverTaskCollection(creds: CalendarCreds): Promise<string | null> {
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
      const hasVtodo = /<comp\s+name="VTODO"/.test(b);
      if (href && isCalendar && hasVtodo) hrefs.push(href.trim());
    }
    if (hrefs.length === 0) return null;
    hrefs.sort(collectionIdComparator); // lowest numeric todos-<id> = the default task list
    const path = hrefs[0];
    console.debug('caldav discoverTaskCollection: chose', path);
    const origin = new URL(creds.baseUrl).origin;
    return path.startsWith('http') ? path : origin + path;
  }

  private async resolveTaskCollection(creds: CalendarCreds): Promise<string | null> {
    if (creds.taskCollectionUrl) return creds.taskCollectionUrl;
    // Defensive one-shot fallback if taskCollectionUrl wasn't stored (e.g. legacy connection).
    return this.discoverTaskCollection(creds);
  }

  async createTask(creds: CalendarCreds, task: ProposedTask): Promise<{ uid: string }> {
    const taskCol = await this.resolveTaskCollection(creds);
    if (!taskCol) throw new Error('CalDAV task collection not found');
    const uid = randomUUID();
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Linkeon//trip//RU\r\n${buildVTodo(task, uid, false)}\r\nEND:VCALENDAR\r\n`;
    const base = taskCol.endsWith('/') ? taskCol : `${taskCol}/`;
    const res = await fetch(`${base}${uid}.ics`, {
      method: 'PUT',
      headers: { Authorization: this.authHeader(creds), 'Content-Type': 'text/calendar; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(8000),
    } as any);
    if (res.status < 200 || res.status >= 300) throw new Error(`CalDAV PUT failed: ${res.status}`);
    return { uid };
  }

  async listTasks(creds: CalendarCreds, start: Date, end: Date): Promise<Task[]> {
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const report = `<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
      <D:prop><C:calendar-data/></D:prop>
      <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO">
        <C:time-range start="${fmt(start)}" end="${fmt(end)}"/>
      </C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
    try {
      const taskCol = await this.resolveTaskCollection(creds);
      if (!taskCol) return [];
      const res = await fetch(taskCol, {
        method: 'REPORT',
        headers: { Authorization: this.authHeader(creds), Depth: '1', 'Content-Type': 'application/xml' },
        body: report, signal: AbortSignal.timeout(8000),
      } as any);
      if (res.status !== 207) return [];
      const xml = await res.text();
      const out: Task[] = [];
      for (const m of xml.matchAll(/BEGIN:VTODO[\s\S]*?END:VTODO/g)) {
        const block = m[0];
        const title = /^SUMMARY:(.*)$/m.exec(block)?.[1]?.trim();
        const uid = /^UID:(.*)$/m.exec(block)?.[1]?.trim();
        const dueLine = /^DUE[^:]*:(.*)$/m.exec(block)?.[1]?.trim();
        // dueLine is the ICS basic value (TZID param already stripped by the regex above) —
        // normalize to an ISO instant so downstream `new Date(due)` parsing never yields NaN.
        const due = dueLine ? (basicToIso(dueLine) ?? dueLine) : undefined;
        const done = /^STATUS:COMPLETED\s*$/m.test(block);
        if (uid) out.push({ uid, title: title || 'Задача', due, done, source: 'yandex' });
      }
      return out;
    } catch (e) {
      console.debug('caldav listTasks failed', e);
      return [];
    }
  }

  async setTaskDone(creds: CalendarCreds, uid: string, done: boolean): Promise<boolean> {
    try {
      const taskCol = await this.resolveTaskCollection(creds);
      if (!taskCol) return false;
      const base = taskCol.endsWith('/') ? taskCol : `${taskCol}/`;
      const url = `${base}${uid}.ics`;
      const getRes = await fetch(url, {
        method: 'GET',
        headers: { Authorization: this.authHeader(creds) },
        signal: AbortSignal.timeout(8000),
      } as any);
      if (getRes.status < 200 || getRes.status >= 300) return false;
      const current = await getRes.text();
      const title = /^SUMMARY:(.*)$/m.exec(current)?.[1]?.trim() || 'Задача';
      const dueLine = /^DUE[^:]*:(.*)$/m.exec(current)?.[1]?.trim();
      // dueLine is an ICS local stamp "20260720T090000" — reverse icsLocal() back to naive "2026-07-20T09:00:00".
      const dueMatch = dueLine ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(dueLine) : null;
      const datetime = dueMatch ? `${dueMatch[1]}-${dueMatch[2]}-${dueMatch[3]}T${dueMatch[4]}:${dueMatch[5]}:${dueMatch[6]}` : undefined;
      const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Linkeon//trip//RU\r\n${buildVTodo({ title, datetime }, uid, done)}\r\nEND:VCALENDAR\r\n`;
      const putRes = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: this.authHeader(creds), 'Content-Type': 'text/calendar; charset=utf-8' },
        body,
        signal: AbortSignal.timeout(8000),
      } as any);
      return putRes.status >= 200 && putRes.status < 300;
    } catch (e) {
      console.debug('caldav setTaskDone failed', e);
      return false;
    }
  }
}
