import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

// Дефолтный промпт «энергии дня» (пресет Райи) — общий для быстрой кнопки и
// дефолта MCP-инструмента. Без ChatService-зависимости → импортируется обеими
// сторонами без цикла.
export const ENERGY_PROMPT =
  'Это проактивное утреннее сообщение: я тебе НЕ писал — ты сама пишешь мне доброе утро. ' +
  'Дай мне «энергию дня» на сегодня: короткое тёплое вдохновляющее послание (2–4 предложения) ' +
  'и один мягкий фокус/намерение на день. Обращайся лично, тактично, тепло, без канцелярита ' +
  'и без длинных списков. Не спрашивай разрешения — просто подари энергию дня.';

// Максимум рутин на пользователя (защита от абьюза/спама генерациями).
export const MAX_ROUTINES_PER_USER = 12;

export interface RoutineRow {
  id: string;
  userId: string;
  title: string;
  assistantId: string;
  prompt: string;
  sendHour: number;
  tz: string;
  days: number[] | null; // локальные дни недели 0..6 (0=Вс); null/[] = каждый день
  enabled: boolean;
  lastSentDate: string | null;
}

@Injectable()
export class RoutineStore {
  constructor(private readonly pg: PgService) {}

  // ── Локальное время/дата/день недели в tz без сторонних либ ───────────────────
  localHour(tz: string, now: Date): number {
    try {
      // Часть ICU форматирует полночь как "24" (даже с h23) → нормализуем % 24.
      const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false, hourCycle: 'h23' }).format(now), 10);
      return Number.isFinite(h) ? (h % 24) : now.getUTCHours();
    } catch { return now.getUTCHours(); }
  }
  localDate(tz: string, now: Date): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    } catch { return now.toISOString().slice(0, 10); }
  }
  localDow(tz: string, now: Date): number {
    try {
      const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
      const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return map[wd] ?? now.getUTCDay();
    } catch { return now.getUTCDay(); }
  }
  toISO(d: any): string {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  }

  // Запланирован ли пуш на сегодня по дням недели (пустой список = каждый день).
  scheduledToday(days: number[] | null | undefined, tz: string, now: Date): boolean {
    if (!days || days.length === 0) return true;
    return days.includes(this.localDow(tz, now));
  }

  private map(row: any): RoutineRow {
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title || 'Напоминание',
      assistantId: row.assistant_id,
      prompt: row.prompt,
      sendHour: row.send_hour,
      tz: row.tz,
      days: Array.isArray(row.days) ? row.days.map((n: any) => Number(n)) : null,
      enabled: row.enabled,
      lastSentDate: row.last_sent_date ? this.toISO(row.last_sent_date) : null,
    };
  }

  private readonly COLS =
    'id, user_id, title, assistant_id, prompt, send_hour, tz, days, enabled, last_sent_date';

  // ── Нормализация входа ───────────────────────────────────────────────────────
  private clampHour(h: any): number {
    return Number.isFinite(h) ? Math.min(23, Math.max(0, Math.trunc(h))) : 8;
  }
  private normTz(tz: any): string {
    return (typeof tz === 'string' && /^[\w+\-/]+$/.test(tz)) ? tz : 'Europe/Moscow';
  }
  private normDays(days: any): number[] | null {
    if (!Array.isArray(days)) return null;
    const s = [...new Set(days.map((d: any) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    return s.length === 0 || s.length === 7 ? null : s; // все 7 или пусто = каждый день
  }

  // last_sent на момент сохранения: час уже прошёл сегодня И сегодня плановый день
  // → today (не стрелять немедленно); иначе NULL (сработает в ближайший плановый час).
  private computeLastSent(enabled: boolean, hour: number, tz: string, days: number[] | null, now: Date): string | null {
    if (!enabled) return null;
    if (!this.scheduledToday(days, tz, now)) return null;
    return this.localHour(tz, now) >= hour ? this.localDate(tz, now) : null;
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────
  async list(userId: string): Promise<RoutineRow[]> {
    const r = await this.pg.query(
      `SELECT ${this.COLS} FROM routine_pushes WHERE user_id = $1 ORDER BY send_hour, created_at`,
      [userId],
    );
    return r.rows.map((row) => this.map(row));
  }

  async getById(userId: string, id: string): Promise<RoutineRow | null> {
    const r = await this.pg.query(
      `SELECT ${this.COLS} FROM routine_pushes WHERE user_id = $1 AND id = $2 LIMIT 1`,
      [userId, id],
    );
    return r.rows[0] ? this.map(r.rows[0]) : null;
  }

  async findByAssistant(userId: string, assistantId: string): Promise<RoutineRow | null> {
    const r = await this.pg.query(
      `SELECT ${this.COLS} FROM routine_pushes WHERE user_id = $1 AND assistant_id = $2 ORDER BY created_at LIMIT 1`,
      [userId, assistantId],
    );
    return r.rows[0] ? this.map(r.rows[0]) : null;
  }

  async count(userId: string): Promise<number> {
    const r = await this.pg.query(`SELECT count(*)::int AS n FROM routine_pushes WHERE user_id = $1`, [userId]);
    return r.rows[0]?.n || 0;
  }

  async knownTz(userId: string): Promise<string | null> {
    const r = await this.pg.query(
      `SELECT tz FROM routine_pushes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    return r.rows[0]?.tz || null;
  }

  async create(
    userId: string,
    data: { title: string; assistantId: string; prompt: string; sendHour?: number; tz?: string; days?: any; enabled?: boolean },
  ): Promise<RoutineRow> {
    if ((await this.count(userId)) >= MAX_ROUTINES_PER_USER) {
      throw new Error(`limit reached: не больше ${MAX_ROUTINES_PER_USER} рутин`);
    }
    const hour = this.clampHour(data.sendHour);
    const tz = this.normTz(data.tz);
    const days = this.normDays(data.days);
    const enabled = data.enabled !== false;
    const now = new Date();
    const lastSent = this.computeLastSent(enabled, hour, tz, days, now);
    const r = await this.pg.query(
      `INSERT INTO routine_pushes (user_id, kind, title, assistant_id, prompt, send_hour, tz, days, enabled, last_sent_date)
       VALUES ($1, 'custom', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${this.COLS}`,
      [userId, (data.title || 'Напоминание').slice(0, 80), String(data.assistantId), data.prompt, hour, tz, days, enabled, lastSent],
    );
    return this.map(r.rows[0]);
  }

  async update(
    userId: string,
    id: string,
    patch: { title?: string; assistantId?: string; prompt?: string; sendHour?: number; tz?: string; days?: any; enabled?: boolean },
  ): Promise<RoutineRow | null> {
    const cur = await this.getById(userId, id);
    if (!cur) return null;
    const title = patch.title !== undefined ? patch.title.slice(0, 80) : cur.title;
    const assistantId = patch.assistantId !== undefined ? String(patch.assistantId) : cur.assistantId;
    const prompt = patch.prompt !== undefined ? patch.prompt : cur.prompt;
    const hour = patch.sendHour !== undefined ? this.clampHour(patch.sendHour) : cur.sendHour;
    const tz = patch.tz !== undefined ? this.normTz(patch.tz) : cur.tz;
    const days = patch.days !== undefined ? this.normDays(patch.days) : cur.days;
    const enabled = patch.enabled !== undefined ? patch.enabled : cur.enabled;
    const now = new Date();
    // Пересчитываем last_sent авторитетно (смена часа/дней/включения не должна залипать).
    const lastSent = this.computeLastSent(enabled, hour, tz, days, now);
    const r = await this.pg.query(
      `UPDATE routine_pushes
          SET title=$3, assistant_id=$4, prompt=$5, send_hour=$6, tz=$7, days=$8, enabled=$9,
              last_sent_date=$10, updated_at=now()
        WHERE user_id=$1 AND id=$2
        RETURNING ${this.COLS}`,
      [userId, id, title, assistantId, prompt, hour, tz, days, enabled, lastSent],
    );
    return r.rows[0] ? this.map(r.rows[0]) : null;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const r = await this.pg.query(`DELETE FROM routine_pushes WHERE user_id=$1 AND id=$2`, [userId, id]);
    return (r.rowCount || 0) > 0;
  }

  // ── Крон ─────────────────────────────────────────────────────────────────────
  async listEnabled(): Promise<Array<{ id: string; user_id: string; title: string; assistant_id: string; prompt: string; send_hour: number; tz: string; days: number[] | null; last_sent_date: any }>> {
    const r = await this.pg.query(
      `SELECT id, user_id, title, assistant_id, prompt, send_hour, tz, days, last_sent_date
         FROM routine_pushes WHERE enabled = true`,
    );
    return r.rows.map((row: any) => ({ ...row, days: Array.isArray(row.days) ? row.days.map((n: any) => Number(n)) : null }));
  }

  async claimToday(id: string, todayLocal: string): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE routine_pushes SET last_sent_date = $2, updated_at = now()
         WHERE id = $1 AND (last_sent_date IS DISTINCT FROM $2) RETURNING id`,
      [id, todayLocal],
    );
    return (r.rowCount || 0) > 0;
  }
}
