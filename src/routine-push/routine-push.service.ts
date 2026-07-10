import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { PushService } from '../push/push.service';
import { ChatService } from '../chat/chat.service';
import { sendTelegramAlert } from '../common/telegram-alert';

// Дефолтный промпт «энергии дня». Хранится в строке рутины (будущие рутины
// могут задавать свой), но для старта — единый узкий сценарий.
const ENERGY_PROMPT =
  'Это проактивное утреннее сообщение: я тебе НЕ писал — ты сама пишешь мне доброе утро. ' +
  'Дай мне «энергию дня» на сегодня: короткое тёплое вдохновляющее послание (2–4 предложения) ' +
  'и один мягкий фокус/намерение на день. Обращайся лично, тактично, тепло, без канцелярита ' +
  'и без длинных списков. Не спрашивай разрешения — просто подари энергию дня.';

export interface RoutineConfig {
  kind: string;
  assistantId: string;
  prompt: string;
  sendHour: number;
  tz: string;
  enabled: boolean;
  lastSentDate: string | null;
}

@Injectable()
export class RoutinePushService implements OnModuleInit {
  private readonly logger = new Logger(RoutinePushService.name);

  constructor(
    private readonly pg: PgService,
    private readonly push: PushService,
    private readonly chat: ChatService,
  ) {}

  async onModuleInit() {
    for (const p of [
      path.join(__dirname, 'migrations', '001_routine_pushes.sql'),
      path.join(__dirname, '..', '..', 'src', 'routine-push', 'migrations', '001_routine_pushes.sql'),
    ]) {
      try {
        if (fs.existsSync(p)) { await this.pg.query(fs.readFileSync(p, 'utf8')); this.logger.log(`routine_pushes migration applied from ${p}`); break; }
      } catch (e: any) { this.logger.error(`routine_pushes migration failed (${p}): ${e.message}`); }
    }
  }

  // ── Локальное время в заданной tz без сторонних либ ──────────────────────────
  private localHour(tz: string, now: Date): number {
    try {
      const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false, hourCycle: 'h23' }).format(now);
      return parseInt(s, 10);
    } catch { return now.getUTCHours(); }
  }
  private localDate(tz: string, now: Date): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    } catch { return now.toISOString().slice(0, 10); }
  }

  // ── User-facing config ───────────────────────────────────────────────────────
  async getForUser(userId: string): Promise<RoutineConfig | null> {
    const r = await this.pg.query(
      `SELECT kind, assistant_id, prompt, send_hour, tz, enabled, last_sent_date
         FROM routine_pushes WHERE user_id = $1 AND kind = 'energy_of_day' LIMIT 1`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      kind: row.kind,
      assistantId: row.assistant_id,
      prompt: row.prompt,
      sendHour: row.send_hour,
      tz: row.tz,
      enabled: row.enabled,
      lastSentDate: row.last_sent_date ? this.toISO(row.last_sent_date) : null,
    };
  }

  private toISO(d: any): string {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  }

  async upsert(userId: string, opts: { enabled: boolean; sendHour?: number; tz?: string }): Promise<RoutineConfig> {
    const hour = Number.isFinite(opts.sendHour as number)
      ? Math.min(23, Math.max(0, Math.trunc(opts.sendHour as number)))
      : 8;
    const tz = (opts.tz && /^[\w+\-/]+$/.test(opts.tz)) ? opts.tz : 'Europe/Moscow';

    // Чтобы включение днём (уже после send_hour) НЕ вызвало сюрприз-пуш прямо
    // сейчас — помечаем сегодняшний день отправленным, если локально уже >= часа.
    const now = new Date();
    const markToday = opts.enabled && this.localHour(tz, now) >= hour;
    const todayLocal = this.localDate(tz, now);

    await this.pg.query(
      `INSERT INTO routine_pushes (user_id, kind, assistant_id, prompt, send_hour, tz, enabled, last_sent_date)
       VALUES ($1, 'energy_of_day', '14', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, kind) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             send_hour = EXCLUDED.send_hour,
             tz = EXCLUDED.tz,
             last_sent_date = CASE WHEN $7 THEN EXCLUDED.last_sent_date ELSE routine_pushes.last_sent_date END,
             updated_at = now()`,
      [userId, ENERGY_PROMPT, hour, tz, opts.enabled, markToday ? todayLocal : null, markToday],
    );
    return (await this.getForUser(userId))!;
  }

  // ── Генерация + сохранение + пуш для одной рутины ────────────────────────────
  private async deliver(userId: string, assistantId: string, prompt: string): Promise<number> {
    const text = await this.chat.generateAgentReply(userId, assistantId, prompt);
    if (!text || !text.trim()) {
      this.logger.warn(`routine deliver: empty text for ${userId}`);
      return 0;
    }
    // Сохраняем как проактивную реплику ассистента (без фейкового human-хода) —
    // чтобы по тапу пуша открылось прямо в чате Райи.
    const agentNum = /^\d+$/.test(assistantId) ? parseInt(assistantId, 10) : null;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'ai', $2, $3, 'text')`,
      [`${userId}_${assistantId}`, agentNum, text],
    );
    const body = text.replace(/[#*_`>\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 130);
    return this.push.sendPush(userId, {
      title: 'Энергия дня от Райи 🌅',
      body,
      url: '/chat?assistant=raya',
      tag: 'energy_of_day',
    });
  }

  // Немедленная проверка (кнопка «Проверить сейчас»): игнорирует время/дубль-гард.
  async fireNow(userId: string): Promise<{ delivered: number }> {
    const cfg = await this.getForUser(userId);
    const assistantId = cfg?.assistantId || '14';
    const prompt = cfg?.prompt || ENERGY_PROMPT;
    const delivered = await this.deliver(userId, assistantId, prompt);
    return { delivered };
  }

  // ── Крон: раз в час на :00 проверяет, кому пора ──────────────────────────────
  @Cron('0 0 * * * *')
  async runDue() {
    if (process.env.ROUTINE_PUSH_DISABLED === 'true') return;
    let rows: any[];
    try {
      rows = (await this.pg.query(
        `SELECT id, user_id, assistant_id, prompt, send_hour, tz, last_sent_date
           FROM routine_pushes WHERE enabled = true`,
      )).rows;
    } catch (e: any) {
      this.logger.error(`runDue query failed: ${e.message}`);
      return;
    }
    const now = new Date();
    let fired = 0;
    for (const r of rows) {
      try {
        const lh = this.localHour(r.tz, now);
        if (lh < r.send_hour) continue;                         // ещё не утро в его tz
        const today = this.localDate(r.tz, now);
        if (r.last_sent_date && this.toISO(r.last_sent_date) === today) continue; // уже слали сегодня
        // Атомарный клейм: только один прогон реально отправит.
        const claim = await this.pg.query(
          `UPDATE routine_pushes SET last_sent_date = $2, updated_at = now()
             WHERE id = $1 AND (last_sent_date IS DISTINCT FROM $2) RETURNING id`,
          [r.id, today],
        );
        if (claim.rowCount === 0) continue;
        const n = await this.deliver(r.user_id, r.assistant_id, r.prompt);
        fired++;
        this.logger.log(`energy_of_day sent to ${r.user_id} (delivered=${n})`);
      } catch (e: any) {
        this.logger.error(`runDue deliver failed for ${r?.user_id}: ${e.message}`);
      }
    }
    if (fired > 0) {
      try { await sendTelegramAlert(`🌅 Энергия дня разослана: ${fired} польз.`); } catch {}
    }
  }
}
