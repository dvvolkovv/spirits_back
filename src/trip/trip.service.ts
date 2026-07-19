import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { CoPilotState } from './trip.types';
import { CalendarService } from '../calendar/calendar.service';
import { CalEvent, Task } from '../calendar/calendar.types';

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
  for (const e of events) {
    const conflict = events.some((o) => o.uid !== e.uid && overlaps(e, o));
    contextLines.push({
      icon: conflict ? '⚠️' : '📅',
      text: `${fmt.format(new Date(e.at)).replace(/,/g, '')} — ${e.title}${conflict ? ' (пересечение)' : ''}`,
      tone: conflict ? 'warn' : undefined,
    });
  }

  const reminders = tasks.map((t) => ({ id: t.uid, text: t.title, when: t.due ?? '', critical: false, done: t.done }));
  const timeTriggers = pending
    .filter((t) => t.due)
    .map((t) => ({ id: `task-${t.uid}`, at: t.due!, title: 'Напоминание', body: t.title }));

  return {
    headline,
    sub: undefined,
    contextLines,
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
    const [tasks, events] = await Promise.all([
      this.calendar.listTasks(userId, start, end),
      this.calendar.listEvents(userId, start, end),
    ]);
    return computeCopilotState({ tasks, events, now: new Date() });
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
    }

    return this.getState(userId);
  }
}
