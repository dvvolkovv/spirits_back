import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { Task } from './calendar.types';
import { Recurrence, expandOccurrences } from './recurrence';

const OFFSET = '+05:00'; // Asia/Yekaterinburg

/** YYYY-MM-DD в локальной зоне (Екб) для инстанта. */
function localDay(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
/** naive-local "YYYY-MM-DDTHH:MM:SS" (Екб) — якорь для expandOccurrences. */
function naiveLocal(d: Date): string {
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
}
const iso = (v: any): string | undefined => (v ? new Date(v).toISOString() : undefined);

/**
 * Хранилище дел/рутин Линкеона [«дом дел», 2026-08-01] — облачная правда (мультиустройство,
 * устойчивость к потере устройства); лаунчер/приложение держат лишь кэш. События сюда НЕ пишем
 * (они агрегируются из внешних календарей); тут только ДЕЛА и РУТИНЫ со статусом.
 *
 * `list()` разворачивает рутины в per-occurrence экземпляры Task за окно (сегодня + будущее в окне),
 * применяя поштучный статус; одноразовые дела висят пока не закрыты (просрочка сохраняется), рутины
 * сбрасываются каждый день (вчерашнее незакрытое вхождение не тащится). Чистая трансформация из
 * строк БД покрыта юнит-тестами (pg замокан).
 */
@Injectable()
export class LinkeonTasksService {
  private readonly logger = new Logger(LinkeonTasksService.name);
  constructor(private readonly pg: PgService) {}

  async ensureTable(): Promise<void> {
    await this.pg.query(
      `CREATE TABLE IF NOT EXISTS linkeon_tasks (
         uid        UUID PRIMARY KEY,
         user_id    TEXT NOT NULL,
         title      TEXT NOT NULL,
         due        TIMESTAMPTZ,
         deadline   TIMESTAMPTZ,
         note       TEXT,
         recurrence JSONB,
         status     TEXT NOT NULL DEFAULT 'pending',
         done_at    TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await this.pg.query(`CREATE INDEX IF NOT EXISTS linkeon_tasks_user ON linkeon_tasks(user_id)`);
    await this.pg.query(
      `CREATE TABLE IF NOT EXISTS linkeon_task_occurrences (
         task_uid        UUID NOT NULL,
         occurrence_date DATE NOT NULL,
         status          TEXT NOT NULL DEFAULT 'pending',
         done_at         TIMESTAMPTZ,
         due_override    TIMESTAMPTZ,
         PRIMARY KEY (task_uid, occurrence_date)
       )`,
    );
  }

  /** Создать дело/рутину. Для рутины `due` = якорь (дата+время первого вхождения). */
  async create(
    userId: string,
    t: { title: string; due?: string; deadline?: string; note?: string; recurrence?: Recurrence },
  ): Promise<{ uid: string }> {
    const uid = randomUUID();
    await this.pg.query(
      `INSERT INTO linkeon_tasks (uid, user_id, title, due, deadline, note, recurrence)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uid, userId, t.title, t.due ?? null, t.deadline ?? null, t.note ?? null, t.recurrence ? JSON.stringify(t.recurrence) : null],
    );
    return { uid };
  }

  /** Отметить сделано/не сделано. Рутина: occurrenceDate помечает КОНКРЕТНЫЙ день (не серию). */
  async setDone(userId: string, uid: string, done: boolean, occurrenceDate?: string): Promise<void> {
    if (occurrenceDate) {
      await this.pg.query(
        `INSERT INTO linkeon_task_occurrences (task_uid, occurrence_date, status, done_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (task_uid, occurrence_date)
         DO UPDATE SET status=EXCLUDED.status, done_at=EXCLUDED.done_at`,
        [uid, occurrenceDate, done ? 'done' : 'pending', done ? new Date().toISOString() : null],
      );
      return;
    }
    await this.pg.query(
      `UPDATE linkeon_tasks SET status=$3, done_at=$4, updated_at=now() WHERE user_id=$1 AND uid=$2`,
      [userId, uid, done ? 'done' : 'pending', done ? new Date().toISOString() : null],
    );
  }

  /** Перенести на другое время. Рутина: перенос ОДНОГО вхождения (due_override), иначе — самого дела. */
  async reschedule(userId: string, uid: string, newDue: string, occurrenceDate?: string): Promise<void> {
    if (occurrenceDate) {
      await this.pg.query(
        `INSERT INTO linkeon_task_occurrences (task_uid, occurrence_date, status, due_override)
         VALUES ($1,$2,'pending',$3)
         ON CONFLICT (task_uid, occurrence_date) DO UPDATE SET due_override=EXCLUDED.due_override`,
        [uid, occurrenceDate, newDue],
      );
      return;
    }
    await this.pg.query(`UPDATE linkeon_tasks SET due=$3, updated_at=now() WHERE user_id=$1 AND uid=$2`, [userId, uid, newDue]);
  }

  /** Снять (потеряло актуальность). */
  async drop(userId: string, uid: string): Promise<void> {
    await this.pg.query(`UPDATE linkeon_tasks SET status='dropped', updated_at=now() WHERE user_id=$1 AND uid=$2`, [userId, uid]);
  }

  /** Дела/рутины за окно [from,to] как Task[] — вход в computeCopilotState. */
  async list(userId: string, from: Date, to: Date, now: Date = new Date()): Promise<Task[]> {
    const rows = (
      await this.pg.query(
        `SELECT uid, title, due, deadline, note, recurrence, status, done_at FROM linkeon_tasks
         WHERE user_id=$1 AND status <> 'dropped'`,
        [userId],
      )
    ).rows as any[];
    const occRows = (
      await this.pg.query(
        `SELECT task_uid, to_char(occurrence_date,'YYYY-MM-DD') AS occ, status, done_at, due_override
         FROM linkeon_task_occurrences WHERE task_uid = ANY($1::uuid[])`,
        [rows.filter((r) => r.recurrence).map((r) => r.uid)],
      )
    ).rows as any[];
    const occByTask = new Map<string, Map<string, any>>();
    for (const o of occRows) {
      if (!occByTask.has(o.task_uid)) occByTask.set(o.task_uid, new Map());
      occByTask.get(o.task_uid)!.set(o.occ, o);
    }

    const today = localDay(now);
    const out: Task[] = [];
    for (const r of rows) {
      const deadline = iso(r.deadline);
      if (!r.recurrence) {
        // Одноразовое дело.
        const done = r.status === 'done';
        const due = iso(r.due);
        if (done) {
          if (r.done_at && localDay(new Date(r.done_at)) === today) {
            out.push({ uid: r.uid, title: r.title, due, deadline, done: true, status: 'done', doneAt: iso(r.done_at), source: 'linkeon' });
          }
        } else if (!due || new Date(due) <= to) {
          // pending: без срока / в окне / просрочено (due<from<to) — висит.
          out.push({ uid: r.uid, title: r.title, due, deadline, done: false, status: 'pending', source: 'linkeon' });
        }
      } else {
        // Рутина: развернуть вхождения, показать сегодня + будущее в окне.
        const recurrence: Recurrence = typeof r.recurrence === 'string' ? JSON.parse(r.recurrence) : r.recurrence;
        const anchor = r.due ? naiveLocal(new Date(r.due)) : `${today}T09:00:00`;
        const occs = expandOccurrences({ datetime: anchor, recurrence });
        const occMap = occByTask.get(r.uid) || new Map();
        for (const dt of occs) {
          const occDate = dt.slice(0, 10);
          if (occDate < today) continue; // прошедшие дни рутины не тащим (сбрасывается каждый день)
          const o = occMap.get(occDate);
          const instant = o?.due_override ? new Date(o.due_override) : new Date(`${dt}${OFFSET}`);
          if (instant > to) continue;
          const st = o?.status || 'pending';
          if (st === 'skipped') continue;
          if (st === 'done') {
            if (occDate === today) {
              out.push({ uid: r.uid, title: r.title, due: instant.toISOString(), done: true, status: 'done', isRoutine: true, occurrenceDate: occDate, doneAt: iso(o?.done_at) ?? instant.toISOString(), source: 'linkeon' });
            }
          } else {
            out.push({ uid: r.uid, title: r.title, due: instant.toISOString(), deadline, done: false, status: 'pending', isRoutine: true, occurrenceDate: occDate, source: 'linkeon' });
          }
        }
      }
    }
    return out;
  }
}
