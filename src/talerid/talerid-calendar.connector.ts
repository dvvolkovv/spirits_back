import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TalerIdOauthService } from './talerid-oauth.service';
import { expandOccurrences } from '../calendar/recurrence';
import { CalEvent, ProposedEvent } from '../calendar/calendar.types';

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
      const raw = await this.callTool(userId, 'list_calendar_events', {
        from: start.toISOString(),
        to: end.toISOString(),
      });
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
}
