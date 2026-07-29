import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { CoPilotState } from './trip.types';
import { CalendarService } from '../calendar/calendar.service';
import { CalEvent, Task } from '../calendar/calendar.types';
import { TalerIdCalendarConnector } from '../talerid/talerid-calendar.connector';

export const TRIP_STATE_VERSION = 1;

export interface TripAction {
  kind: string;
  payload: any;
}

/**
 * Pure function: the universal co-pilot state over the user's real tasks +
 * calendar events. Replaces the old trip-specific computeState (which read a
 * hardcoded TripPlan: legs/fuel/roadMarks/deadline/window). No I/O, no LLM —
 * deterministic given (tasks, events, now), so both the launcher and tests
 * can reproduce it exactly.
 *
 * - headline: nearest incomplete task by due date; falls back to the nearest
 *   event, then a calm default.
 * - contextLines: one line per event (📅), flagged ⚠️/warn on a REAL time
 *   overlap with another event (not the old "3h before departure" heuristic).
 * - reminders: ALL tasks (done and pending) so the launcher can render
 *   checkboxes; reminders[i].id is the task uid (carries into task_done).
 * - timeTriggers: pending tasks that have a due date.
 */
/**
 * Слить события из нескольких источников (ICS-календари + TalerID) в один список [6ad042df],
 * убрав дубли: один и тот же митинг может прийти и из Yandex/Outlook-ICS, и из TalerID-календаря.
 * Ключ дедупа = нормализованный заголовок + время начала с точностью до минуты. Порядок входа
 * сохраняется (первый источник выигрывает). Чистая функция — юнит-тестируется без сети.
 */
export function mergeEvents(...sources: CalEvent[][]): CalEvent[] {
  const seen = new Set<string>();
  const out: CalEvent[] = [];
  for (const list of sources) {
    for (const e of list) {
      const minute = e.at ? new Date(e.at).toISOString().slice(0, 16) : '';
      const key = `${(e.title || '').trim().toLowerCase()}|${minute}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

export function computeCopilotState(input: { tasks: Task[]; events: CalEvent[]; now: Date }): CoPilotState {
  const { tasks, events, now } = input;
  const parse = (s: string) => new Date(s.includes('+') || s.endsWith('Z') ? s : `${s}+05:00`).getTime();

  const pending = tasks
    .filter((t) => !t.done)
    .sort((a, b) => (a.due ? parse(a.due) : Infinity) - (b.due ? parse(b.due) : Infinity));
  const next = pending[0];
  const headline = next
    ? `Ближайшее: ${next.title}`
    : events[0]
      ? `Ближайшее событие: ${events[0].title}`
      : 'Пока всё спокойно';

  const contextLines: CoPilotState['contextLines'] = [];
  const overlaps = (a: { at: string; end?: string }, b: { at: string; end?: string }) => {
    const as = parse(a.at);
    const ae = a.end ? parse(a.end) : as + 3_600_000;
    const bs = parse(b.at);
    const be = b.end ? parse(b.end) : bs + 3_600_000;
    return as < be && bs < ae;
  };
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Yekaterinburg',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const eventsOut: NonNullable<CoPilotState['events']> = [];
  events.forEach((e, i) => {
    const conflict = events.some((o, j) => j !== i && overlaps(e, o));
    contextLines.push({
      icon: conflict ? '⚠️' : '📅',
      text: `${fmt.format(new Date(e.at)).replace(/,/g, '')} — ${e.title}${conflict ? ' (пересечение)' : ''}`,
      tone: conflict ? 'warn' : undefined,
    });
    // Структурированное событие для лаунчера [784fd182]: ISO-время → он сам ранжирует/рендерит
    // «ближайшую встречу». contextLines оставляем для обратной совместимости.
    eventsOut.push({ at: e.at, end: e.end, title: e.title, conflict });
  });

  const reminders = tasks.map((t) => ({ id: t.uid, text: t.title, when: t.due ?? '', critical: false, done: t.done }));
  const timeTriggers = pending
    .filter((t) => t.due)
    .map((t) => ({ id: `task-${t.uid}`, at: t.due!, title: 'Напоминание', body: t.title }));

  return {
    headline,
    sub: undefined,
    contextLines,
    events: eventsOut,
    reminders,
    geoTriggers: [],
    timeTriggers,
    version: TRIP_STATE_VERSION,
    serverTime: now.toISOString(),
  };
}

@Injectable()
export class TripService implements OnModuleInit {
  private readonly logger = new Logger(TripService.name);

  constructor(
    private readonly pg: PgService,
    private readonly calendar: CalendarService,
    private readonly taleridCalendar: TalerIdCalendarConnector,
  ) {}

  async onModuleInit() {
    try {
      // Read-only ICS calendar sources per user (personal + work). URLs carry private tokens, so
      // they're stored in the DB (not committed) — seeded out-of-band via SQL, not in code. Still
      // consumed directly by CalendarService.listEvents (T6), so the table must keep existing.
      await this.pg.query(
        `CREATE TABLE IF NOT EXISTS trip_calendars (
           user_id TEXT NOT NULL,
           kind    TEXT NOT NULL,
           url     TEXT NOT NULL,
           enabled BOOLEAN NOT NULL DEFAULT true,
           PRIMARY KEY (user_id, kind)
         )`,
      );
    } catch (e: any) {
      this.logger.error(`trip_calendars table init failed: ${e.message}`);
    }
  }

  /**
   * Universal co-pilot state: real tasks + events for this user, next 7 days.
   * No more hardcoded TripPlan/seed — the window is just "now .. now+7d".
   */
  async getState(userId: string): Promise<CoPilotState> {
    const now = new Date();
    const start = now;
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [tasks, icsEvents, taleridEvents] = await Promise.all([
      this.calendar.listTasks(userId, start, end),
      this.calendar.listEvents(userId, start, end),
      // TalerID-календарь — ещё один источник событий [6ad042df]. Коннектор best-effort:
      // при не-подключённом TalerID / ошибке MCP вернёт [], со-пилот не ломается.
      this.taleridCalendar.listEvents(userId, start, end),
    ]);
    const events = mergeEvents(icsEvents, taleridEvents);
    const state = computeCopilotState({ tasks, events, now: new Date() });
    // Pending-предложения агента [a5131311] — докладываем в стейт (чистая computeCopilotState их не
    // знает, это async из БД). Absent-safe: пустой список → лаунчер ничего не показывает.
    const pending = await this.calendar.listPendingProposals(userId);
    // Контентный дедуп [фикс дублей 2026-07-29]: не предлагаем добавить то, что УЖЕ есть в календаре.
    // Кроет кросс-поверхностный вектор: событие создали в чате (POST /calendar/events, статус
    // предложения не тронут) → без этого фильтра виджет показал бы предложение снова → второй add.
    // Матч по нормализованному title + datetime в пределах ±10 мин (или тот же день, если без времени).
    const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const eventInCalendar = (ev: { title?: string; datetime?: string }): boolean => {
      const t = norm(ev?.title || '');
      if (!t) return false;
      const pdt = ev?.datetime ? new Date(`${ev.datetime}${ev.datetime.includes('+') || ev.datetime.endsWith('Z') ? '' : '+05:00'}`).getTime() : NaN;
      return events.some((e) => {
        if (norm(e.title) !== t) return false;
        if (Number.isNaN(pdt)) return true; // предложение без времени + совпал title → считаем что уже есть
        const et = new Date(e.at).getTime();
        return Number.isFinite(et) && Math.abs(et - pdt) <= 10 * 60_000;
      });
    };
    state.proposals = pending
      .filter((p) => !eventInCalendar(p.event as any))
      .map((p) => ({
        id: p.id,
        kind: 'calendar_event',
        payload: { event: p.event },
      }));
    return state;
  }

  /**
   * task_done {uid, done} is the only mutating action left: it marks a real
   * task done/undone via CalendarService (CalDAV VTODO), then the state is
   * recomputed fresh. Older trip-specific kinds (checkin/deadline_update/
   * departed/reminder_done) no longer apply to anything — retired along with
   * the hardcoded TripPlan — and are simply ignored (no-op) rather than
   * erroring, so any stale queued client action can't 400 loudly.
   */
  async applyAction(userId: string, idemKey: string, kind: string, payload: any): Promise<CoPilotState> {
    if (!idemKey) throw new BadRequestException('idemKey required');
    if (!kind) throw new BadRequestException('kind required');

    if (kind === 'task_done') {
      const uid = payload?.uid;
      if (!uid) throw new BadRequestException('uid required');
      await this.calendar.setTaskDone(userId, uid, Boolean(payload?.done));
    } else if (kind === 'proposal_accept') {
      // Предложение агента принято из лаунчера [a5131311]. Идемпотентность [фикс дублей 2026-07-29]:
      // СНАЧАЛА флипаем pending→accepted (атомарно, rowCount) и создаём событие ТОЛЬКО если реально
      // флипнули — второй accept того же id (двойной тап / гонка) вернёт false и НЕ задвоит событие.
      // При ошибке записи откатываем статус в pending, чтобы предложение не потерялось.
      const id = payload?.id;
      if (!id) throw new BadRequestException('id required');
      const flipped = await this.calendar.setProposalStatus(userId, id, 'accepted');
      if (flipped) {
        const p = await this.calendar.getProposal(userId, id);
        if (p && p.kind === 'event' && p.event) {
          const res = await this.calendar.createEvent(userId, p.event);
          if (!res.ok) await this.calendar.revertProposalToPending(userId, id);
        }
      }
    } else if (kind === 'proposal_dismiss') {
      const id = payload?.id;
      if (!id) throw new BadRequestException('id required');
      await this.calendar.setProposalStatus(userId, id, 'dismissed');
    }

    return this.getState(userId);
  }
}
