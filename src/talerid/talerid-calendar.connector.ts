import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TalerIdOauthService } from './talerid-oauth.service';
import { expandOccurrences } from '../calendar/recurrence';
import { CalEvent, ProposedEvent, Task } from '../calendar/calendar.types';

const TZID = 'Asia/Yekaterinburg';
const OFFSET = '+05:00'; // Asia/Yekaterinburg, no DST — mirrors src/calendar/{recurrence,caldav}.ts

function mcpBaseUrl(): string {
  const base = process.env.TALERID_BASE_URL || 'https://staging.id.taler.tirol';
  return `${base.replace(/\/$/, '')}/mcp`;
}

/**
 * Convert a naive-local occurrence string ("2026-08-17T09:45:00", as produced by
 * expandOccurrences) into an offset ISO 8601 string TalerID's create_calendar_event expects
 * ("2026-08-17T09:45:00+05:00").
 */
function occurrenceToOffsetIso(occ: string): string {
  return `${occ}${OFFSET}`;
}

/**
 * Compute the offset-ISO endAt for an occurrence: parse the +05:00 start instant, add
 * durationMin minutes, and render the resulting instant back as an Asia/Yekaterinburg
 * wall-clock string with the same fixed offset — mirrors buildVEvent's end computation in
 * src/calendar/caldav.ts.
 */
function endOffsetIso(startOffsetIso: string, durationMin: number): string {
  const start = new Date(startOffsetIso);
  const end = new Date(start.getTime() + durationMin * 60_000);
  const endNaive = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZID, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(end).replace(' ', 'T');
  return `${endNaive}${OFFSET}`;
}

/**
 * Task 4 — TalerID calendar connector, implemented over the TalerID MCP server (`mcp:calendar`
 * scope). TalerID's MCP is stateless Streamable HTTP (POST-only, no session) — every call opens
 * a fresh transport+client, authenticated with a per-user Bearer access token from
 * TalerIdOauthService, and closes the transport afterwards.
 *
 * Only implements the event subset of CalendarConnector (list/create) — TalerID has no tasks
 * concept and no RRULE, so a recurring/multi-date ProposedEvent is expanded into N individual
 * create_calendar_event calls via expandOccurrences (reused from src/calendar/recurrence.ts).
 *
 * Best-effort like the Yandex connector: any failure (not connected, MCP error, unexpected
 * payload shape) degrades listEvents to `[]` rather than throwing, so co-pilot aggregation
 * never breaks because TalerID is unavailable.
 */
@Injectable()
export class TalerIdCalendarConnector {
  private readonly logger = new Logger(TalerIdCalendarConnector.name);

  constructor(private readonly oauth: TalerIdOauthService) {}

  /**
   * Get a fresh mcp:calendar access token, open a stateless Streamable HTTP transport+client
   * carrying it as a Bearer header, call the named tool, and parse the JSON out of the single
   * `text` content block TalerID always returns. Throws on: no token (not connected), an
   * `isError` tool result, or a transport/JSON-RPC failure — callers decide how to degrade.
   */
  protected async callTool(userId: string, name: string, args: Record<string, any>): Promise<any> {
    const token = await this.oauth.getBackendAccessToken(userId);
    if (!token) throw new Error('talerid: not connected (no access token)');

    const transport = new StreamableHTTPClientTransport(new URL(mcpBaseUrl()), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'linkeon-talerid-connector', version: '1.0.0' });
    try {
      await client.connect(transport);
      const result: any = await client.callTool({ name, arguments: args });
      if (result?.isError) {
        const msg = result?.content?.[0]?.text ?? 'unknown MCP error';
        throw new Error(`talerid mcp ${name} isError: ${msg}`);
      }
      const text = result?.content?.[0]?.text;
      return typeof text === 'string' ? JSON.parse(text) : text;
    } finally {
      try { await client.close(); } catch { /* best-effort cleanup */ }
      try { await transport.close(); } catch { /* best-effort cleanup */ }
    }
  }

  async listEvents(userId: string, start: Date, end: Date): Promise<CalEvent[]> {
    try {
      // TalerID's list_calendar_events filters on DATE-ONLY strings (YYYY-MM-DD),
      // NOT full ISO datetimes — passing a datetime returns nothing on a real
      // account (verified live: raw date-only query finds events, datetime finds
      // 0). Callers pass precise Date windows (co-pilot day view, findConflicts
      // intraday ±3h), so collapse to dates and guarantee to > from (an intraday
      // window would otherwise give from==to and miss the day). Over-fetching to
      // day granularity is harmless — callers re-filter by each event's precise at.
      const from = start.toISOString().slice(0, 10);
      let to = end.toISOString().slice(0, 10);
      if (to <= from) {
        to = new Date(new Date(`${from}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
      }
      const raw = await this.callTool(userId, 'list_calendar_events', { from, to });
      const events = Array.isArray(raw) ? raw : Array.isArray(raw?.events) ? raw.events : [];
      const out: CalEvent[] = [];
      for (const ev of events) {
        if (!ev?.startAt) continue;
        const startMs = new Date(ev.startAt).getTime();
        if (Number.isNaN(startMs)) continue; // skip ONE malformed row, keep the rest (don't drop the batch)
        const item: CalEvent = {
          at: new Date(startMs).toISOString(),
          title: String(ev.title || '').trim() || 'Событие',
          source: 'talerid',
          uid: ev.id,
        };
        if (ev.endAt) {
          const endMs = new Date(ev.endAt).getTime();
          if (!Number.isNaN(endMs)) item.end = new Date(endMs).toISOString();
        }
        out.push(item);
      }
      return out;
    } catch (e: any) {
      this.logger.debug(`talerid listEvents degraded to [] for user ${userId}: ${e?.message}`);
      return [];
    }
  }

  async createEvent(userId: string, event: ProposedEvent): Promise<{ created: number; failed: number; ids: string[] }> {
    const occurrences = expandOccurrences({
      datetime: event.datetime,
      recurrence: event.recurrence,
      dates: event.dates,
    });
    const durationMin = event.durationMin ?? 60;

    let created = 0;
    let failed = 0;
    const ids: string[] = [];

    for (const occ of occurrences) {
      const startAt = occurrenceToOffsetIso(occ);
      const args: Record<string, any> = {
        title: event.title,
        type: 'EVENT',
        startAt,
        endAt: endOffsetIso(startAt, durationMin),
      };
      if (event.note) args.description = event.note;

      try {
        const result = await this.callTool(userId, 'create_calendar_event', args);
        created++;
        if (result?.id) ids.push(result.id);
      } catch (e: any) {
        failed++;
        this.logger.debug(`talerid createEvent occurrence ${occ} failed for user ${userId}: ${e?.message}`);
      }
    }

    return { created, failed, ids };
  }

  /**
   * Удалить событие в TalerID по его id (uid из listEvents == ev.id) через MCP delete_calendar_event
   * [удаление 2026-07-29, owner подтвердил поддержку]. Best-effort: ошибка MCP → {ok:false}.
   */
  async deleteEvent(userId: string, id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.callTool(userId, 'delete_calendar_event', { id });
      return { ok: true };
    } catch (e: any) {
      this.logger.debug(`talerid deleteEvent ${id} failed for user ${userId}: ${e?.message}`);
      return { ok: false, error: 'Не удалось удалить событие' };
    }
  }

  // ---- Задачи/рутины TalerID [Фаза 2 спеки, live на PROD 2026-08-02: list_tasks/set_task_status/
  //      update_task, scope mcp:calendar]. Зеркалит форму linkeon-tasks.list (→ зона «Дела»
  //      применяет ту же логику). Best-effort: не подключён / ошибка MCP → []/{ok:false}. ----

  private localDay(ms: number): string {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Yekaterinburg' }).format(new Date(ms));
  }

  async listTasks(userId: string, start: Date, end: Date, now: Date): Promise<Task[]> {
    try {
      const from = start.toISOString().slice(0, 10);
      let to = end.toISOString().slice(0, 10);
      if (to <= from) to = new Date(new Date(`${from}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
      const raw = await this.callTool(userId, 'list_tasks', { from, to, includeDone: true });
      const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.tasks) ? raw.tasks : [];
      const out: Task[] = [];
      const toMs = end.getTime();
      const today = this.localDay(now.getTime());
      for (const t of rows) {
        if (!t?.uid) continue;
        const title = String(t.title || '').trim() || 'Дело';
        const deadline = t.deadline ? new Date(t.deadline).toISOString() : undefined;
        if (t.recurrence && Array.isArray(t.occurrences)) {
          // Рутина: поштучные вхождения; прошедшие дни не тащим (сброс каждый день), skipped прячем,
          // done показываем только сегодня (приглушённо), pending — висит.
          for (const o of t.occurrences) {
            const occDate: string = o?.occurrenceDate;
            if (!occDate || occDate < today) continue;
            const st = o?.status || 'pending';
            if (st === 'skipped') continue;
            const instant = o?.dueOverride ? new Date(o.dueOverride) : new Date(`${occDate}T09:00:00${OFFSET}`);
            if (Number.isNaN(instant.getTime()) || instant.getTime() > toMs) continue;
            if (st === 'done') {
              if (occDate === today) {
                out.push({ uid: t.uid, title, due: instant.toISOString(), done: true, status: 'done', isRoutine: true, occurrenceDate: occDate, doneAt: o?.doneAt ? new Date(o.doneAt).toISOString() : instant.toISOString(), source: 'talerid' });
              }
            } else {
              out.push({ uid: t.uid, title, due: instant.toISOString(), deadline, done: false, status: 'pending', isRoutine: true, occurrenceDate: occDate, source: 'talerid' });
            }
          }
        } else {
          // Разовое дело: pending (без срока / в окне / просрочено) висит; done-сегодня приглушённо.
          const done = t.status === 'done';
          const due = t.due ? new Date(t.due).toISOString() : undefined;
          if (done) {
            if (t.doneAt && this.localDay(new Date(t.doneAt).getTime()) === today) {
              out.push({ uid: t.uid, title, due, deadline, done: true, status: 'done', doneAt: new Date(t.doneAt).toISOString(), source: 'talerid' });
            }
          } else if (t.status !== 'dropped' && (!due || new Date(due).getTime() <= toMs)) {
            out.push({ uid: t.uid, title, due, deadline, done: false, status: 'pending', source: 'talerid' });
          }
        }
      }
      return out;
    } catch (e: any) {
      this.logger.debug(`talerid listTasks degraded to [] for user ${userId}: ${e?.message}`);
      return [];
    }
  }

  async setTaskStatus(userId: string, id: string, status: 'done' | 'pending' | 'dropped', occurrenceDate?: string): Promise<{ ok: boolean }> {
    try {
      const args: Record<string, any> = { id, status };
      if (occurrenceDate) args.occurrenceDate = occurrenceDate; // рутина: конкретный день (§3.4)
      await this.callTool(userId, 'set_task_status', args);
      return { ok: true };
    } catch (e: any) {
      this.logger.debug(`talerid set_task_status ${id} failed for user ${userId}: ${e?.message}`);
      return { ok: false };
    }
  }

  // Перенос: у TalerID нет per-occurrence-reschedule инструмента (dueOverride есть в модели, но tool —
  // нет). Разовое двигаем через update_task(due). Перенос вхождения рутины — best-effort no-op.
  async rescheduleTask(userId: string, id: string, newDue: string, occurrenceDate?: string): Promise<{ ok: boolean }> {
    if (occurrenceDate) return { ok: false };
    try {
      await this.callTool(userId, 'update_task', { id, due: newDue });
      return { ok: true };
    } catch (e: any) {
      this.logger.debug(`talerid update_task ${id} failed for user ${userId}: ${e?.message}`);
      return { ok: false };
    }
  }

}
