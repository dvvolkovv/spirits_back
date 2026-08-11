import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { YandexCalDavConnector } from './caldav';
import { CalEvent, CalendarCreds, ProposedEvent, ProposedTask, Task } from './calendar.types';
import { fetchCalendarEvents } from '../trip/calendar'; // read-only ICS sources (T6)
import { encryptSecret, decryptSecret } from './crypto';
import { ExchangeEwsConnector, ExchangeCreds } from './exchange';
import { expandOccurrences, Recurrence } from './recurrence';
import { LinkeonTasksService } from './linkeon-tasks.service';
import { TalerIdStoreService } from '../talerid/talerid-store.service';
import { TalerIdCalendarConnector } from '../talerid/talerid-calendar.connector';

const OFFSET = '+05:00';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Append the product TZ offset when the ISO string carries none (no trailing Z / ±hh:mm). */
function withOffset(s: string): string {
  return /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}${OFFSET}`;
}
/** Parse an ISO-local range start: date-only → 00:00 that day (product TZ). */
export function parseLocalStart(s: string): Date {
  return new Date(withOffset(DATE_ONLY_RE.test(s) ? `${s}T00:00:00` : s));
}
/** Parse an ISO-local range end: a date-only bound is INCLUSIVE of that whole day → next-day 00:00
 *  (listEvents' window is half-open [start, end)); a datetime is used as-is. */
export function parseLocalEnd(s: string): Date {
  if (DATE_ONLY_RE.test(s)) return new Date(new Date(withOffset(`${s}T00:00:00`)).getTime() + 86_400_000);
  return new Date(withOffset(s));
}

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
  private readonly exchange = new ExchangeEwsConnector();
  /** cache-bust hook set by TripService so an optimistic write refreshes the co-pilot surface. */
  onWrite?: (userId: string) => void;

  constructor(
    private readonly pg: PgService,
    private readonly talerIdStore: TalerIdStoreService,
    private readonly talerIdConnector: TalerIdCalendarConnector,
    private readonly linkeonTasks: LinkeonTasksService,
    @Optional() private readonly claudeCli?: ClaudeCliService,
  ) {}

  /**
   * Best-effort "is TalerID the connected ecosystem for this user" check. Wrapped defensively —
   * a store failure must never break the (Yandex) calendar path, it just means we treat the user
   * as TalerID-not-connected for this call.
   */
  private async talerIdConnected(userId: string): Promise<boolean> {
    try {
      const conn = await this.talerIdStore.getConnection(userId);
      return conn?.status === 'connected';
    } catch (e: any) {
      this.logger.error(`talerid getConnection failed: ${e.message}`);
      return false;
    }
  }

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
    // status = pending | accepted | dismissed [a5131311]: чтобы лаунчер показывал НЕзакрытые
    // предложения агента и мог их принять/отклонить. Дефолт 'pending'; старые строки не всплывут
    // из-за окна свежести в listPendingProposals (не бэкфиллим — окно решает).
    await this.pg.query(`ALTER TABLE calendar_proposals ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`);
  }

  /**
   * Pending-предложения событий для витрины лаунчера [a5131311]. Окно свежести 2 дня — старые
   * (доредизайновые) предложения не всплывают; только kind='event' (их можно «добавить в календарь»).
   */
  async listPendingProposals(userId: string): Promise<{ id: string; event: ProposedEvent; kind: string }[]> {
    const r = await this.pg.query(
      `SELECT id, event, kind FROM calendar_proposals
       WHERE user_id = $1 AND status = 'pending' AND kind = 'event'
         AND created_at > now() - interval '2 days'
       ORDER BY created_at ASC`,
      [userId],
    );
    // Показываем только предложения на БУДУЩЕЕ: предложение «поставить встречу вчера» для уже
    // сделанного дела висело и путало owner'а. Прошедший datetime → предложение неактуально.
    const now = Date.now();
    return r.rows
      .map((row) => ({ id: row.id, event: row.event as ProposedEvent, kind: row.kind }))
      .filter((p) => {
        const dt = p.event?.datetime;
        if (!dt) return true; // без времени (напр. dates-серия) — не отбрасываем
        const t = new Date(`${dt}${dt.includes('+') || dt.endsWith('Z') ? '' : OFFSET}`).getTime();
        return Number.isNaN(t) || t >= now - 60 * 60_000; // грейс час: «идёт сейчас» ещё показываем
      });
  }

  /**
   * Перевести pending→status. Возвращает true, только если РЕАЛЬНО флипнули pending-строку
   * (rowCount>0). Идемпотентность приёма предложения строится на этом: второй accept того же id
   * вернёт false → вызывающий не создаёт второе событие (см. TripService.applyAction).
   */
  async setProposalStatus(userId: string, id: string, status: 'accepted' | 'dismissed'): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE calendar_proposals SET status = $3 WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
      [id, userId, status],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Откат accepted→pending, если запись события в календарь провалилась (не теряем предложение). */
  async revertProposalToPending(userId: string, id: string): Promise<void> {
    await this.pg.query(
      `UPDATE calendar_proposals SET status = 'pending' WHERE id = $1 AND user_id = $2 AND status = 'accepted'`,
      [id, userId],
    );
  }

  /**
   * Persist a proposal so the MCP-bridge (agent) path can be surfaced to chat via
   * [CALENDAR_PROPOSAL:<id>] marker. Anti-dupe: if an identical (same user, same event JSON)
   * proposal was already saved in the last 10s — e.g. an agent re-emitting the tool call — return
   * that existing id instead of INSERTing a second row (avoids duplicate cards for one request).
   */
  async saveProposal(
    userId: string,
    event: ProposedEvent,
    connected: boolean,
    conflicts: { title: string; at: string }[],
    kind: 'event' | 'task' = 'event',
  ): Promise<string> {
    const eventJson = JSON.stringify(event);
    const dupe = await this.pg.query(
      `SELECT id FROM calendar_proposals WHERE user_id=$1 AND created_at > now() - interval '10 seconds' AND event = $2::jsonb LIMIT 1`,
      [userId, eventJson],
    );
    if (dupe.rows[0]) return dupe.rows[0].id;
    const id = randomUUID();
    await this.pg.query(
      `INSERT INTO calendar_proposals (id, user_id, event, connected, conflicts, kind) VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6)`,
      [id, userId, eventJson, connected, JSON.stringify(conflicts), kind],
    );
    return id;
  }

  async getProposal(
    userId: string,
    id: string,
  ): Promise<{
    event: ProposedEvent;
    connected: boolean;
    conflicts: { title: string; at: string }[];
    kind: 'event' | 'task';
    occurrenceCount: number;
    firstAt?: string;
    lastAt?: string;
  } | null> {
    const r = await this.pg.query(`SELECT event, connected, conflicts, kind FROM calendar_proposals WHERE id = $1 AND user_id = $2`, [id, userId]);
    const row = r.rows[0];
    if (!row) return null;
    const occ = expandOccurrences(row.event);
    return {
      event: row.event,
      connected: row.connected,
      conflicts: row.conflicts,
      kind: row.kind,
      occurrenceCount: occ.length,
      firstAt: occ[0],
      lastAt: occ[occ.length - 1],
    };
  }

  private async creds(userId: string): Promise<CalendarCreds | null> {
    const r = await this.pg.query(
      `SELECT base_url, username, secret_enc, collection_url, todo_collection_url FROM calendar_connections WHERE user_id=$1 AND enabled=true AND provider='yandex' LIMIT 1`,
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

  async getStatus(userId: string): Promise<{ connected: boolean; provider?: string; username?: string; canReenable?: boolean; exchange?: { connected: boolean; username?: string } }> {
    const active = await this.pg.query(
      `SELECT provider, username FROM calendar_connections WHERE user_id=$1 AND enabled=true AND provider='yandex' LIMIT 1`,
      [userId],
    );
    // Exchange (рабочий Outlook по EWS) — отдельным полем, параллельно CalDAV-яндексу.
    const ex = await this.pg.query(
      `SELECT username, enabled FROM calendar_connections WHERE user_id=$1 AND provider='exchange' LIMIT 1`,
      [userId],
    );
    const exchange = ex.rows[0]?.enabled ? { connected: true, username: ex.rows[0].username } : { connected: false };
    if (active.rows[0]) return { connected: true, provider: active.rows[0].provider, username: active.rows[0].username, exchange };
    // Отключено, но креды сохранены → предложим переподключить в один тап (без повторного ввода пароля).
    const stored = await this.pg.query(
      `SELECT provider, username FROM calendar_connections WHERE user_id=$1 AND secret_enc IS NOT NULL AND provider='yandex' LIMIT 1`,
      [userId],
    );
    if (stored.rows[0]) return { connected: false, canReenable: true, provider: stored.rows[0].provider, username: stored.rows[0].username, exchange };
    return { connected: false, exchange };
  }

  /** Переподключить сохранённое (отключённое) подключение: проверяем сохранённый пароль приложения
   *  и, если он ещё годен, снова включаем — без повторного ввода. Устарел → просим ввести заново. */
  async reconnect(userId: string): Promise<{ ok: boolean; error?: string }> {
    const row = (await this.pg.query(
      `SELECT provider, base_url, username, secret_enc FROM calendar_connections WHERE user_id=$1 AND secret_enc IS NOT NULL AND provider='yandex' ORDER BY enabled DESC LIMIT 1`,
      [userId],
    )).rows[0];
    if (!row) return { ok: false, error: 'Нет сохранённого подключения' };
    const ok = await this.connector.test({ baseUrl: row.base_url, username: row.username, appPassword: decryptSecret(row.secret_enc) });
    if (!ok) return { ok: false, error: 'Сохранённый пароль больше не подходит — подключи заново по логину и паролю' };
    await this.pg.query(`UPDATE calendar_connections SET enabled=true WHERE user_id=$1 AND provider=$2`, [userId, row.provider]);
    this.onWrite?.(userId); // переподключение меняет co-pilot view — сбрасываем кэш
    return { ok: true };
  }

  async connect(userId: string, provider: string, username: string, appPassword: string): Promise<{ ok: boolean; error?: string }> {
    const baseUrl = 'https://caldav.yandex.ru'; // provider→baseUrl map; yandex only for now
    username = (username || '').trim();
    // Яндекс ПОКАЗЫВАЕТ пароль приложения группами через пробелы («xxxx xxxx xxxx xxxx»), но сам
    // пароль — 16 символов без пробелов. Если ввести как показано, Basic-auth уходит с пробелами
    // → 401 на «правильном» пароле. Убираем ВСЕ пробелы (app-пароли Яндекса/Google их не содержат).
    appPassword = (appPassword || '').replace(/\s+/g, '');
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
    await this.pg.query(`UPDATE calendar_connections SET enabled=false WHERE user_id=$1 AND provider='yandex'`, [userId]);
    this.onWrite?.(userId); // disconnecting also changes the co-pilot view — bust the cache
  }

  // ---- Exchange (рабочий Outlook по EWS/NTLM), read-only ----

  private async exchangeCreds(userId: string): Promise<ExchangeCreds | null> {
    const row = (await this.pg.query(
      `SELECT base_url, username, secret_enc FROM calendar_connections WHERE user_id=$1 AND provider='exchange' AND enabled=true LIMIT 1`,
      [userId],
    )).rows[0];
    if (!row) return null;
    return { server: row.base_url, username: row.username, password: decryptSecret(row.secret_enc) };
  }

  /** Подключить рабочий Exchange по EWS: NTLM username = login@domain, пароль хранится шифрованно.
   *  Проверяем кредами реальный запрос, иначе «подключим» неработающее. */
  async connectExchange(userId: string, server: string, domain: string, login: string, password: string): Promise<{ ok: boolean; error?: string }> {
    server = (server || 'mail.clearwayintegration.com').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    domain = (domain || '').trim();
    login = (login || '').trim();
    if (!server || !login || !password) return { ok: false, error: 'Нужны сервер, логин и пароль' };
    const username = domain ? `${login}@${domain}` : login;
    const ok = await this.exchange.test({ server, username, password });
    if (!ok) return { ok: false, error: 'Не удалось войти — проверь домен, логин и пароль' };
    await this.pg.query(
      `INSERT INTO calendar_connections (user_id, provider, base_url, username, secret_enc, enabled)
       VALUES ($1,'exchange',$2,$3,$4,true)
       ON CONFLICT (user_id, provider) DO UPDATE SET base_url=EXCLUDED.base_url, username=EXCLUDED.username, secret_enc=EXCLUDED.secret_enc, enabled=true`,
      [userId, server, username, encryptSecret(password)],
    );
    this.onWrite?.(userId);
    return { ok: true };
  }

  async disconnectExchange(userId: string): Promise<void> {
    await this.pg.query(`UPDATE calendar_connections SET enabled=false WHERE user_id=$1 AND provider='exchange'`, [userId]);
    this.onWrite?.(userId);
  }

  // ---- Read-only календари по ссылке (ICS): Outlook «Опубликовать календарь», Google, iCloud и т.п.
  //      Хранятся в trip_calendars (PK user_id+kind), читаются в listEvents → co-pilot. ----

  async listIcs(userId: string): Promise<Array<{ kind: string; url: string; enabled: boolean }>> {
    const r = await this.pg.query(
      `SELECT kind, url, enabled FROM trip_calendars WHERE user_id=$1 ORDER BY kind`,
      [userId],
    );
    return r.rows;
  }

  /** Добавить/обновить ICS-источник по ссылке. Проверяем, что ссылка реально отдаёт iCalendar,
   *  иначе пользователь молча «подключит» пустоту. webcal:// → https://. */
  async addIcs(userId: string, kind: string, url: string): Promise<{ ok: boolean; error?: string }> {
    kind = (kind || 'outlook').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'outlook';
    let u = (url || '').trim();
    if (u.toLowerCase().startsWith('webcal://')) u = 'https://' + u.slice('webcal://'.length);
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'Нужна ссылка вида https://… (или webcal://…)' };
    let text = '';
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(8000) } as any);
      if (!res.ok) return { ok: false, error: `Ссылка недоступна (код ${res.status})` };
      text = await res.text();
    } catch {
      return { ok: false, error: 'Не удалось открыть ссылку — проверь адрес' };
    }
    if (!text.includes('BEGIN:VCALENDAR')) return { ok: false, error: 'По ссылке не календарь (нет данных iCalendar)' };
    await this.pg.query(
      `INSERT INTO trip_calendars (user_id, kind, url, enabled) VALUES ($1,$2,$3,true)
       ON CONFLICT (user_id, kind) DO UPDATE SET url=EXCLUDED.url, enabled=true`,
      [userId, kind, u],
    );
    this.onWrite?.(userId); // новый источник меняет co-pilot view — сбрасываем кэш
    return { ok: true };
  }

  async removeIcs(userId: string, kind: string): Promise<void> {
    await this.pg.query(`DELETE FROM trip_calendars WHERE user_id=$1 AND kind=$2`, [userId, kind]);
    this.onWrite?.(userId);
  }

  /**
   * All events in [start,end): the CalDAV connection (live) + read-only ICS sources
   * (trip_calendars) + TalerID (if connected). This union is what feeds the co-pilot
   * (TripService reads via this method), so a connected TalerID account automatically
   * flows into the co-pilot surface with no trip.service changes needed.
   * No cross-source dedup (out of scope — plan §10.5, simple union).
   */
  async listEvents(userId: string, start: Date, end: Date): Promise<CalEvent[]> {
    const out: CalEvent[] = [];
    const creds = await this.creds(userId);
    if (creds) {
      try { out.push(...(await this.connector.listEvents(creds, start, end))); }
      catch (e: any) { this.logger.error(`caldav list failed: ${e.message}`); }
    }
    try {
      const exCreds = await this.exchangeCreds(userId);
      if (exCreds) out.push(...(await this.exchange.listEvents(exCreds, start, end)));
    } catch (e: any) { this.logger.error(`exchange list failed: ${e.message}`); }
    try {
      const icsRows = await this.pg.query(`SELECT url, kind FROM trip_calendars WHERE user_id=$1 AND enabled=true`, [userId]);
      const sources = icsRows.rows.map((r: any) => ({ url: r.url, source: r.kind }));
      if (sources.length) out.push(...(await fetchCalendarEvents(sources, start, end)));
    } catch (e: any) { this.logger.error(`ics list failed: ${e.message}`); }
    try {
      if (await this.talerIdConnected(userId)) {
        out.push(...(await this.talerIdConnector.listEvents(userId, start, end)));
      }
    } catch (e: any) { this.logger.error(`talerid list failed: ${e.message}`); } // defensive — connector already degrades to [] on its own
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * Assistant-facing read over a LOCAL date/datetime range (read_calendar tool). Accepts ISO-local
   * strings without timezone — a date "2026-08-10" or a datetime "2026-08-10T09:00:00" — interpreted
   * in the product TZ (OFFSET). A date-only `to` is INCLUSIVE of that whole day. Returns the same
   * union as listEvents. Throws on an invalid/backwards range; the window is capped at 366 days.
   */
  async listEventsLocalRange(userId: string, fromLocal: string, toLocal: string): Promise<CalEvent[]> {
    const start = parseLocalStart(fromLocal);
    const end = parseLocalEnd(toLocal);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error('некорректные даты периода');
    if (end.getTime() <= start.getTime()) throw new Error('конец периода должен быть позже начала');
    if (end.getTime() - start.getTime() > 366 * 86_400_000) throw new Error('период слишком большой (максимум 366 дней)');
    return this.listEvents(userId, start, end);
  }

  /**
   * Series-aware conflict check: expand every occurrence (single datetime / recurrence / dates —
   * see expandOccurrences), then do ONE listEvents call spanning the whole range (earliest
   * occurrence -3h .. latest occurrence + duration + 3h) rather than one round-trip per occurrence.
   * Each occurrence is then checked for overlap against every listed event; matches are merged and
   * deduped (by uid, falling back to title+at for uid-less sources).
   */
  async findConflicts(userId: string, event: ProposedEvent): Promise<CalEvent[]> {
    const occ = expandOccurrences(event);
    if (occ.length === 0) return [];
    const durationMin = event.durationMin ?? 60;
    const occInstants = occ.map((o) => new Date(`${o}${OFFSET}`).getTime());
    const start = new Date(Math.min(...occInstants) - 3 * 60 * 60_000);
    const end = new Date(Math.max(...occInstants) + durationMin * 60_000 + 3 * 60 * 60_000);
    const events = await this.listEvents(userId, start, end);

    const seen = new Set<string>();
    const matches: CalEvent[] = [];
    for (const o of occ) {
      const proposedOcc: ProposedEvent = { ...event, datetime: o, recurrence: undefined, dates: undefined };
      for (const e of events) {
        if (!overlaps(proposedOcc, e)) continue;
        const key = e.uid ?? `${e.title}|${e.at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(e);
      }
    }
    return matches;
  }

  /**
   * Write-target routing (card flow): default is "TalerID if connected, else Yandex" — there is
   * no per-user target-pref column in this slice (plan §Task5 keeps it simple); if a future slice
   * needs an explicit choice when BOTH are connected, that preference would plug in right here.
   * Recurrence: Yandex keeps writing RRULE as before; TalerID has none, so its connector expands
   * the series into N single-event creates internally (see TalerIdCalendarConnector.createEvent).
   */
  async createEvent(
    userId: string,
    event: ProposedEvent,
  ): Promise<{ ok: boolean; created?: number; failed?: number; uids?: string[]; error?: string }> {
    if (await this.talerIdConnected(userId)) {
      try {
        const { created, failed, ids } = await this.talerIdConnector.createEvent(userId, event);
        if (created > 0) this.onWrite?.(userId); // optimistic: refresh co-pilot surface now
        // Mirror the Yandex shape: on total failure give the card UI something to show.
        return { ok: created > 0, created, failed, uids: ids, error: created > 0 ? undefined : 'Не удалось записать событие' };
      } catch (e: any) {
        this.logger.error(`talerid createEvent failed: ${e.message}`);
        return { ok: false, error: 'Не удалось записать событие' };
      }
    }

    const creds = await this.creds(userId);
    if (!creds) return { ok: false, error: 'Календарь не подключён' };
    try {
      const { created, failed, uids, error } = await this.connector.createEvent(creds, event);
      if (created > 0) this.onWrite?.(userId); // optimistic: refresh co-pilot surface now
      return { ok: created > 0, created, failed, uids, error };
    } catch (e: any) {
      this.logger.error(`createEvent failed: ${e.message}`);
      return { ok: false, error: 'Не удалось записать событие' };
    }
  }

  /**
   * Удалить событие [удаление 2026-07-29]. Роутинг по source: 'talerid' → MCP delete_calendar_event,
   * иначе → CalDAV DELETE ресурса. ICS-источники (read-only) удалять нельзя → честная ошибка.
   * uid — из co-pilot events (talerid: ev.id; caldav: uid ресурса). Успех → бастим co-pilot-кэш.
   */
  async deleteEvent(userId: string, uid: string, source?: string): Promise<{ ok: boolean; error?: string }> {
    if (!uid) return { ok: false, error: 'Нет идентификатора события' };
    if (source === 'talerid') {
      const r = await this.talerIdConnector.deleteEvent(userId, uid);
      if (r.ok) this.onWrite?.(userId);
      return r;
    }
    if (source && source !== 'yandex') {
      // corp/ICS и прочие read-only источники — удалять нечем.
      return { ok: false, error: 'Это событие из внешнего календаря — удали его в источнике' };
    }
    const creds = await this.creds(userId);
    if (!creds) return { ok: false, error: 'Календарь не подключён' };
    const r = await this.connector.deleteEvent(creds, uid);
    if (r.ok) this.onWrite?.(userId);
    return r;
  }

  /**
   * Quick-add из свободной фразы [виджет-календарь]: «добавь ревью в календарь на 11:00» → событие
   * в календаре, БЕЗ карточки-предложения и без чата (лаунчер зовёт это через приложение-хранителя).
   * Одним фокусным вызовом Haiku 4.5 превращаем фразу в структурированное событие (та же форма, что
   * у агентского propose_calendar_event), затем createEvent/createTask и человекочитаемый whenText.
   */
  async quickAddFromText(
    userId: string,
    text: string,
  ): Promise<{ ok: boolean; title?: string; whenText?: string; datetime?: string; kind?: string; error?: string }> {
    const phrase = (text || '').trim();
    if (!phrase) return { ok: false, error: 'Пустой запрос' };
    if (!this.claudeCli) return { ok: false, error: 'Разбор фразы недоступен' };

    // Текущее локальное время (Екатеринбург, без DST) — модели нужен «сейчас», чтобы понять
    // «сегодня/завтра/в 11:00». Даём ISO с зоной + человекочитаемо.
    const now = new Date();
    const nowLocalIso = new Date(now.getTime() + 5 * 3600_000).toISOString().replace('Z', OFFSET);
    const prompt =
      `Ты парсер календарных фраз. Текущее локальное время пользователя: ${nowLocalIso} (Asia/Yekaterinburg).\n` +
      `Преврати фразу в ОДНУ запись. Верни СТРОГО JSON без пояснений:\n` +
      `{"title":"...","kind":"event"|"task","datetime":"YYYY-MM-DDTHH:MM:SS"|null,"durationMin":60,` +
      `"recurrence":{"freq":"daily"|"weekly","byDay":["MO","TU","WE","TH","FR","SA","SU"],"interval":1}|null,` +
      `"deadline":"YYYY-MM-DDTHH:MM:SS"|null}\n` +
      `Правила:\n` +
      `- СОБЫТИЕ (kind=event) — обязательство во времени, обычно с другими или жёсткий слот (встреча, ` +
      `созвон, приём, дейлик). datetime = когда, локальное ISO без зоны.\n` +
      `- ДЕЛО (kind=task) — личное намерение что-то сделать (купить, позвонить, помыться, отправить, ` +
      `сходить). datetime = мягкий ориентир по времени, может быть null если времени нет.\n` +
      `- Повтор («каждый день/по утрам/по будням/каждый понедельник/еженедельно») → recurrence ` +
      `(это рутина, обычно kind=task; byDay для еженедельного), иначе recurrence=null.\n` +
      `- «до HH:MM / крайний срок / дедлайн / успеть к» → deadline, иначе null.\n` +
      `- title — краткое название (без «добавь/поставь/напомни/в календарь»). Относительное время ` +
      `(«на 11:00», «вечером») от «сейчас»; если сегодня прошло — завтра. Не выдумывай дату, если её нет.\n` +
      `Фраза: ${JSON.stringify(phrase)}`;

    let parsed: any = null;
    try {
      const raw = await this.claudeCli.text(prompt, { model: 'claude-haiku-4-5' });
      parsed = this.parseJsonTolerant(raw);
    } catch (e: any) {
      this.logger.error(`quickAdd parse failed: ${e.message}`);
      return { ok: false, error: 'Не удалось разобрать фразу' };
    }
    const title = String(parsed?.title || '').trim();
    if (!title) return { ok: false, error: 'Не понял, что добавить' };
    const kind = parsed?.kind === 'task' ? 'task' : 'event';
    const datetime = typeof parsed?.datetime === 'string' && parsed.datetime ? parsed.datetime : undefined;
    const durationMin = Number.isFinite(parsed?.durationMin) ? Number(parsed.durationMin) : 60;
    const recurrence: Recurrence | undefined =
      parsed?.recurrence && (parsed.recurrence.freq === 'daily' || parsed.recurrence.freq === 'weekly')
        ? {
            freq: parsed.recurrence.freq,
            byDay: Array.isArray(parsed.recurrence.byDay) ? parsed.recurrence.byDay : undefined,
            interval: Number.isFinite(parsed.recurrence.interval) ? Number(parsed.recurrence.interval) : undefined,
          }
        : undefined;
    const deadline = typeof parsed?.deadline === 'string' && parsed.deadline ? `${parsed.deadline}${OFFSET}` : undefined;

    // ДЕЛО/РУТИНА → облачный «дом дел» Линкеона (LinkeonTasksService), НЕ Яндекс-VTODO [owner 2026-08-02].
    if (kind === 'task' || recurrence) {
      const due = datetime ? `${datetime}${OFFSET}` : undefined;
      await this.linkeonTasks.create(userId, { title, due, deadline, recurrence, note: parsed?.note });
      if (this.onWrite) this.onWrite(userId);
      const whenText = recurrence ? 'рутина' : datetime ? this.humanWhen(datetime) : 'в дела';
      return { ok: true, title, kind: 'task', whenText, datetime };
    }
    const event: ProposedEvent = { title, datetime, durationMin, note: parsed?.note };
    const res = await this.createEvent(userId, event);
    if (!res.ok) return { ok: false, error: res.error || 'Не удалось добавить событие' };
    return { ok: true, title, kind: 'event', datetime, whenText: this.humanWhen(datetime) };
  }

  /** «сегодня 11:00» / «завтра 15:30» / «29.07 11:00» — для inline-подтверждения в виджете. */
  private humanWhen(datetimeLocal: string): string {
    const t = new Date(`${datetimeLocal}${datetimeLocal.includes('+') || datetimeLocal.endsWith('Z') ? '' : OFFSET}`);
    if (Number.isNaN(t.getTime())) return datetimeLocal;
    const nowY = new Date(Date.now() + 5 * 3600_000);
    const evY = new Date(t.getTime() + 5 * 3600_000);
    const hh = String(evY.getUTCHours()).padStart(2, '0');
    const mm = String(evY.getUTCMinutes()).padStart(2, '0');
    const dayDiff = Math.floor((Date.UTC(evY.getUTCFullYear(), evY.getUTCMonth(), evY.getUTCDate()) -
      Date.UTC(nowY.getUTCFullYear(), nowY.getUTCMonth(), nowY.getUTCDate())) / 86400_000);
    const when = dayDiff === 0 ? 'сегодня' : dayDiff === 1 ? 'завтра'
      : `${String(evY.getUTCDate()).padStart(2, '0')}.${String(evY.getUTCMonth() + 1).padStart(2, '0')}`;
    return `${when} ${hh}:${mm}`;
  }

  /** Толерантный JSON-парсер (модель иногда оборачивает в markdown/прозу). */
  private parseJsonTolerant(text: string): any | null {
    if (!text) return null;
    let s = text.trim();
    if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    try { return JSON.parse(s); } catch { /* fall through to brace scan */ }
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (!inStr && c === '{') depth++;
      if (!inStr && c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
    }
    return null;
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
