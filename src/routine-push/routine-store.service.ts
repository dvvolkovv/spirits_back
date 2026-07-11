import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

// Хранилище конфигов рутинных пушей (Слой 3). Только Postgres, без ChatService —
// чтобы им могли пользоваться И RoutinePushService (крон/доставка), И
// ChatToolsService (MCP-инструмент manage_routine) без циклической зависимости.
//
// Ключ рутины: kind = `daily:<assistantId>` — одна ежедневная рутина на пару
// (пользователь, ассистент). Поэтому «энергия дня» Райи из Настроек и из чата —
// одна и та же строка (без дублей пушей).

// Дефолтный промпт «энергии дня» (рутина Райи) — общий для тумблера в Настройках
// и дефолта MCP-инструмента manage_routine. Живёт здесь (без ChatService-зависимости),
// чтобы обе стороны импортировали без цикла.
export const ENERGY_PROMPT =
  'Это проактивное утреннее сообщение: я тебе НЕ писал — ты сама пишешь мне доброе утро. ' +
  'Дай мне «энергию дня» на сегодня: короткое тёплое вдохновляющее послание (2–4 предложения) ' +
  'и один мягкий фокус/намерение на день. Обращайся лично, тактично, тепло, без канцелярита ' +
  'и без длинных списков. Не спрашивай разрешения — просто подари энергию дня.';

export interface RoutineRow {
  userId: string;
  assistantId: string;
  kind: string;
  prompt: string;
  sendHour: number;
  tz: string;
  enabled: boolean;
  lastSentDate: string | null;
}

@Injectable()
export class RoutineStore {
  constructor(private readonly pg: PgService) {}

  kindFor(assistantId: string): string { return `daily:${assistantId}`; }

  // ── Локальное время в tz без сторонних либ ───────────────────────────────────
  localHour(tz: string, now: Date): number {
    try {
      // ВАЖНО: у части ICU полночь форматируется как "24", а не "00" (даже с
      // hourCycle h23) — из-за этого рутина срабатывала в полночь вместо
      // заданного часа. Нормализуем `% 24` (24→0). Инцидент 2026-07-11.
      const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false, hourCycle: 'h23' }).format(now), 10);
      return Number.isFinite(h) ? (h % 24) : now.getUTCHours();
    } catch { return now.getUTCHours(); }
  }
  localDate(tz: string, now: Date): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    } catch { return now.toISOString().slice(0, 10); }
  }
  toISO(d: any): string {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  }

  private map(row: any): RoutineRow {
    return {
      userId: row.user_id,
      assistantId: row.assistant_id,
      kind: row.kind,
      prompt: row.prompt,
      sendHour: row.send_hour,
      tz: row.tz,
      enabled: row.enabled,
      lastSentDate: row.last_sent_date ? this.toISO(row.last_sent_date) : null,
    };
  }

  async get(userId: string, assistantId: string): Promise<RoutineRow | null> {
    const r = await this.pg.query(
      `SELECT user_id, kind, assistant_id, prompt, send_hour, tz, enabled, last_sent_date
         FROM routine_pushes WHERE user_id = $1 AND kind = $2 LIMIT 1`,
      [userId, this.kindFor(assistantId)],
    );
    return r.rows[0] ? this.map(r.rows[0]) : null;
  }

  // Последний известный tz пользователя (из любой его рутины) — чтобы рутина,
  // созданная из чата (где браузерного tz нет), унаследовала верный пояс.
  async knownTz(userId: string): Promise<string | null> {
    const r = await this.pg.query(
      `SELECT tz FROM routine_pushes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    return r.rows[0]?.tz || null;
  }

  async upsert(
    userId: string,
    assistantId: string,
    opts: { enabled: boolean; sendHour?: number; tz?: string; prompt: string },
  ): Promise<RoutineRow> {
    const hour = Number.isFinite(opts.sendHour as number)
      ? Math.min(23, Math.max(0, Math.trunc(opts.sendHour as number)))
      : 8;
    const tz = (opts.tz && /^[\w+\-/]+$/.test(opts.tz)) ? opts.tz : 'Europe/Moscow';

    // Включение уже после send_hour → помечаем сегодня отправленным, чтобы не
    // выстрелить пуш немедленно (первый настоящий — завтра утром).
    const now = new Date();
    const markToday = opts.enabled && this.localHour(tz, now) >= hour;
    const today = this.localDate(tz, now);

    await this.pg.query(
      `INSERT INTO routine_pushes (user_id, kind, assistant_id, prompt, send_hour, tz, enabled, last_sent_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, kind) DO UPDATE
         SET assistant_id = EXCLUDED.assistant_id,
             prompt = EXCLUDED.prompt,
             enabled = EXCLUDED.enabled,
             send_hour = EXCLUDED.send_hour,
             tz = EXCLUDED.tz,
             last_sent_date = CASE WHEN $9 THEN EXCLUDED.last_sent_date ELSE routine_pushes.last_sent_date END,
             updated_at = now()`,
      [userId, this.kindFor(assistantId), assistantId, opts.prompt, hour, tz, opts.enabled, markToday ? today : null, markToday],
    );
    return (await this.get(userId, assistantId))!;
  }

  async listEnabled(): Promise<Array<{ id: string; user_id: string; assistant_id: string; prompt: string; send_hour: number; tz: string; last_sent_date: any }>> {
    const r = await this.pg.query(
      `SELECT id, user_id, assistant_id, prompt, send_hour, tz, last_sent_date
         FROM routine_pushes WHERE enabled = true`,
    );
    return r.rows as any[];
  }

  // Атомарный клейм на сегодня: true — этот вызов «застолбил» отправку.
  async claimToday(id: string, todayLocal: string): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE routine_pushes SET last_sent_date = $2, updated_at = now()
         WHERE id = $1 AND (last_sent_date IS DISTINCT FROM $2) RETURNING id`,
      [id, todayLocal],
    );
    return r.rowCount > 0;
  }
}
