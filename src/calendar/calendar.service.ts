import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { YandexCalDavConnector } from './caldav';
import { CalEvent, CalendarCreds, ProposedEvent, ProposedTask, Task } from './calendar.types';
import { fetchCalendarEvents } from '../trip/calendar'; // read-only ICS sources (T6)
import { encryptSecret, decryptSecret } from './crypto';

const OFFSET = '+05:00';

/** Pure overlap check: does a proposed event (naive local + duration) intersect an existing CalEvent? */
export function overlaps(p: ProposedEvent, existing: CalEvent, durationMin = 60): boolean {
  const ps = new Date(`${p.datetime}${OFFSET}`).getTime();
  const pe = ps + (p.durationMin ?? durationMin) * 60_000;
  const es = new Date(existing.at).getTime();
  const ee = existing.end ? new Date(existing.end).getTime() : es + 60 * 60_000;
  return ps < ee && es < pe;
}

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);
  private readonly connector = new YandexCalDavConnector();
  /** cache-bust hook set by TripService so an optimistic write refreshes the co-pilot surface. */
  onWrite?: (userId: string) => void;

  constructor(private readonly pg: PgService) {}

  async ensureTable(): Promise<void> {
    await this.pg.query(
      `CREATE TABLE IF NOT EXISTS calendar_connections (
         user_id TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT NOT NULL,
         username TEXT NOT NULL, secret_enc TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
         PRIMARY KEY (user_id, provider))`,
    );
    await this.pg.query(`ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS collection_url TEXT`);
    await this.pg.query(`ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS todo_collection_url TEXT`);
    await this.pg.query(
      `CREATE TABLE IF NOT EXISTS calendar_proposals (
         id UUID PRIMARY KEY,
         user_id TEXT NOT NULL,
         event JSONB NOT NULL,
         connected BOOLEAN NOT NULL,
         conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    // kind = 'event' | 'task' — which surface the proposal targets ("Мои дела" vs the calendar).
    // Default 'event' preserves the pre-T4 behaviour for already-stored proposals.
    await this.pg.query(`ALTER TABLE calendar_proposals ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'event'`);
  }

  /** Persist a proposal so the MCP-bridge (agent) path can be surfaced to chat via [CALENDAR_PROPOSAL:<id>] marker. */
  async saveProposal(
    userId: string,
    event: ProposedEvent,
    connected: boolean,
    conflicts: { title: string; at: string }[],
    kind: 'event' | 'task' = 'event',
  ): Promise<string> {
    const id = randomUUID();
    await this.pg.query(
      `INSERT INTO calendar_proposals (id, user_id, event, connected, conflicts, kind) VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6)`,
      [id, userId, JSON.stringify(event), connected, JSON.stringify(conflicts), kind],
    );
    return id;
  }

  async getProposal(
    userId: string,
    id: string,
  ): Promise<{ event: ProposedEvent; connected: boolean; conflicts: { title: string; at: string }[]; kind: 'event' | 'task' } | null> {
    const r = await this.pg.query(`SELECT event, connected, conflicts, kind FROM calendar_proposals WHERE id = $1 AND user_id = $2`, [id, userId]);
    const row = r.rows[0];
    return row ? { event: row.event, connected: row.connected, conflicts: row.conflicts, kind: row.kind } : null;
  }

  private async creds(userId: string): Promise<CalendarCreds | null> {
    const r = await this.pg.query(
      `SELECT base_url, username, secret_enc, collection_url, todo_collection_url FROM calendar_connections WHERE user_id=$1 AND enabled=true LIMIT 1`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      baseUrl: row.base_url,
      username: row.username,
      appPassword: decryptSecret(row.secret_enc),
      collectionUrl: row.collection_url || undefined,
      taskCollectionUrl: row.todo_collection_url || undefined,
    };
  }

  async getStatus(userId: string): Promise<{ connected: boolean; provider?: string }> {
    const r = await this.pg.query(`SELECT provider FROM calendar_connections WHERE user_id=$1 AND enabled=true LIMIT 1`, [userId]);
    return r.rows[0] ? { connected: true, provider: r.rows[0].provider } : { connected: false };
  }

  async connect(userId: string, provider: string, username: string, appPassword: string): Promise<{ ok: boolean; error?: string }> {
    const baseUrl = 'https://caldav.yandex.ru'; // provider→baseUrl map; yandex only for now
    const ok = await this.connector.test({ baseUrl, username, appPassword });
    if (!ok) return { ok: false, error: 'Не удалось подключиться — проверь логин и пароль приложения' };
    const collectionUrl = await this.connector.discoverCollection({ baseUrl, username, appPassword });
    if (!collectionUrl) return { ok: false, error: 'Не нашёл календарь для записи' };
    // Task (VTODO) collection is best-effort: not every account has a "Мои дела" list, and its
    // absence must not block connecting the calendar itself — tasks just stay unavailable.
    const todoCollectionUrl = await this.connector.discoverTaskCollection({ baseUrl, username, appPassword });
    await this.pg.query(
      `INSERT INTO calendar_connections (user_id, provider, base_url, username, secret_enc, enabled, collection_url, todo_collection_url)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7)
       ON CONFLICT (user_id, provider) DO UPDATE SET base_url=EXCLUDED.base_url, username=EXCLUDED.username, secret_enc=EXCLUDED.secret_enc, enabled=true, collection_url=EXCLUDED.collection_url, todo_collection_url=EXCLUDED.todo_collection_url`,
      [userId, provider, baseUrl, username, encryptSecret(appPassword), collectionUrl, todoCollectionUrl],
    );
    this.onWrite?.(userId); // connecting changes what listEvents returns — bust the co-pilot cache
    return { ok: true };
  }

  async disconnect(userId: string): Promise<void> {
    await this.pg.query(`UPDATE calendar_connections SET enabled=false WHERE user_id=$1`, [userId]);
    this.onWrite?.(userId); // disconnecting also changes the co-pilot view — bust the cache
  }

  /** All events in [start,end): the CalDAV connection (live) + read-only ICS sources (trip_calendars). */
  async listEvents(userId: string, start: Date, end: Date): Promise<CalEvent[]> {
    const out: CalEvent[] = [];
    const creds = await this.creds(userId);
    if (creds) {
      try { out.push(...(await this.connector.listEvents(creds, start, end))); }
      catch (e: any) { this.logger.error(`caldav list failed: ${e.message}`); }
    }
    try {
      const icsRows = await this.pg.query(`SELECT url, kind FROM trip_calendars WHERE user_id=$1 AND enabled=true`, [userId]);
      const sources = icsRows.rows.map((r: any) => ({ url: r.url, source: r.kind }));
      if (sources.length) out.push(...(await fetchCalendarEvents(sources, start, end)));
    } catch (e: any) { this.logger.error(`ics list failed: ${e.message}`); }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  async findConflicts(userId: string, event: ProposedEvent): Promise<CalEvent[]> {
    const at = new Date(`${event.datetime}${OFFSET}`);
    const start = new Date(at.getTime() - 3 * 60 * 60_000);
    const end = new Date(at.getTime() + (event.durationMin ?? 60) * 60_000 + 3 * 60 * 60_000);
    const events = await this.listEvents(userId, start, end);
    return events.filter((e) => overlaps(event, e));
  }

  async createEvent(userId: string, event: ProposedEvent): Promise<{ ok: boolean; uid?: string; error?: string }> {
    const creds = await this.creds(userId);
    if (!creds) return { ok: false, error: 'Календарь не подключён' };
    try {
      const { uid } = await this.connector.createEvent(creds, event);
      this.onWrite?.(userId); // optimistic: refresh co-pilot surface now
      return { ok: true, uid };
    } catch (e: any) {
      this.logger.error(`createEvent failed: ${e.message}`);
      return { ok: false, error: 'Не удалось записать событие' };
    }
  }

  async createTask(userId: string, task: ProposedTask): Promise<{ ok: boolean; uid?: string; error?: string }> {
    const creds = await this.creds(userId);
    if (!creds || !creds.taskCollectionUrl) return { ok: false, error: 'Задачи недоступны' };
    try {
      const { uid } = await this.connector.createTask(creds, task);
      this.onWrite?.(userId); // optimistic: refresh co-pilot surface now
      return { ok: true, uid };
    } catch (e: any) {
      this.logger.error(`createTask failed: ${e.message}`);
      return { ok: false, error: 'Не удалось записать задачу' };
    }
  }

  async listTasks(userId: string, start: Date, end: Date): Promise<Task[]> {
    const creds = await this.creds(userId);
    if (!creds || !creds.taskCollectionUrl) return [];
    try {
      return await this.connector.listTasks(creds, start, end);
    } catch (e: any) {
      this.logger.error(`listTasks failed: ${e.message}`);
      return [];
    }
  }

  async setTaskDone(userId: string, uid: string, done: boolean): Promise<{ ok: boolean; error?: string }> {
    const creds = await this.creds(userId);
    if (!creds || !creds.taskCollectionUrl) return { ok: false, error: 'Задачи недоступны' };
    try {
      const ok = await this.connector.setTaskDone(creds, uid, done);
      if (!ok) return { ok: false, error: 'Не удалось обновить задачу' };
      this.onWrite?.(userId); // optimistic: refresh co-pilot surface now
      return { ok: true };
    } catch (e: any) {
      this.logger.error(`setTaskDone failed: ${e.message}`);
      return { ok: false, error: 'Не удалось обновить задачу' };
    }
  }
}
