import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { PushService } from '../push/push.service';
import { ChatService } from '../chat/chat.service';
import { RoutineStore, RoutineRow, ENERGY_PROMPT } from './routine-store.service';
import { sendTelegramAlert } from '../common/telegram-alert';

const RAYA_ID = '14';

@Injectable()
export class RoutinePushService implements OnModuleInit {
  private readonly logger = new Logger(RoutinePushService.name);

  constructor(
    private readonly pg: PgService,
    private readonly push: PushService,
    private readonly chat: ChatService,
    private readonly store: RoutineStore,
  ) {}

  async onModuleInit() {
    // Применяем ВСЕ миграции модуля по порядку (001, 002, …), идемпотентно.
    for (const base of [
      path.join(__dirname, 'migrations'),
      path.join(__dirname, '..', '..', 'src', 'routine-push', 'migrations'),
    ]) {
      try {
        if (!fs.existsSync(base)) continue;
        const files = fs.readdirSync(base).filter((f) => f.endsWith('.sql')).sort();
        for (const f of files) {
          try { await this.pg.query(fs.readFileSync(path.join(base, f), 'utf8')); this.logger.log(`routine migration applied: ${f}`); }
          catch (e: any) { this.logger.error(`routine migration failed (${f}): ${e.message}`); }
        }
        break;
      } catch (e: any) { this.logger.error(`routine migrations dir failed (${base}): ${e.message}`); }
    }
  }

  // ── Пресет «энергия дня» (быстрая кнопка на фронте) ──────────────────────────
  async ensureEnergyPreset(userId: string, tz?: string): Promise<RoutineRow> {
    const existing = (await this.store.list(userId)).find((r) => r.assistantId === RAYA_ID && r.title === 'Энергия дня');
    if (existing) return existing;
    return this.store.create(userId, {
      title: 'Энергия дня',
      assistantId: RAYA_ID,
      prompt: ENERGY_PROMPT,
      sendHour: 8,
      tz: tz || (await this.store.knownTz(userId)) || 'Europe/Moscow',
      days: null,
      enabled: true,
    });
  }

  // ── Доставка одной рутины ────────────────────────────────────────────────────
  private async deliver(userId: string, assistantId: string, prompt: string, title?: string): Promise<number> {
    const text = await this.chat.generateAgentReply(userId, assistantId, prompt);
    if (!text || !text.trim()) {
      this.logger.warn(`routine deliver: empty text for ${userId} / assistant ${assistantId}`);
      return 0;
    }
    const agentNum = /^\d+$/.test(assistantId) ? parseInt(assistantId, 10) : null;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'ai', $2, $3, 'text')`,
      [`${userId}_${assistantId}`, agentNum, text],
    );
    const name = await this.assistantName(assistantId);
    const body = text.replace(/[#*_`>\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 130);
    const isEnergy = assistantId === RAYA_ID && (title === 'Энергия дня' || !title);
    return this.push.sendPush(userId, {
      title: isEnergy ? 'Энергия дня от Райи 🌅' : `${title || 'Напоминание'} · ${name} ✨`,
      body,
      url: `/chat?assistant=${assistantId}`,
      tag: `routine_${assistantId}`,
    });
  }

  private async assistantName(assistantId: string): Promise<string> {
    if (!/^\d+$/.test(assistantId)) return 'ассистент';
    try {
      const r = await this.pg.query('SELECT COALESCE(display_name, name) AS n FROM agents WHERE id = $1', [parseInt(assistantId, 10)]);
      return r.rows[0]?.n || 'ассистент';
    } catch { return 'ассистент'; }
  }

  // «Проверить сейчас»: генерит и шлёт немедленно конкретную рутину.
  async fireNow(userId: string, routineId: string): Promise<{ delivered: number } | null> {
    const r = await this.store.getById(userId, routineId);
    if (!r) return null;
    const delivered = await this.deliver(userId, r.assistantId, r.prompt, r.title);
    return { delivered };
  }

  // ── Крон: раз в час на :00 ───────────────────────────────────────────────────
  @Cron('0 0 * * * *')
  async runDue() {
    if (process.env.ROUTINE_PUSH_DISABLED === 'true') return;
    let rows: Awaited<ReturnType<RoutineStore['listEnabled']>>;
    try { rows = await this.store.listEnabled(); }
    catch (e: any) { this.logger.error(`runDue query failed: ${e.message}`); return; }

    const now = new Date();
    let fired = 0;
    for (const r of rows) {
      try {
        if (!this.store.scheduledToday(r.days, r.tz, now)) continue;         // не сегодня по дням недели
        if (this.store.localHour(r.tz, now) < r.send_hour) continue;         // ещё не время в его tz
        const today = this.store.localDate(r.tz, now);
        if (r.last_sent_date && this.store.toISO(r.last_sent_date) === today) continue;
        if (!(await this.store.claimToday(r.id, today))) continue;           // уже застолбили
        const n = await this.deliver(r.user_id, r.assistant_id, r.prompt, r.title);
        fired++;
        this.logger.log(`routine "${r.title}" sent to ${r.user_id} (assistant ${r.assistant_id}, delivered=${n})`);
      } catch (e: any) {
        this.logger.error(`runDue deliver failed for ${r?.user_id}: ${e.message}`);
      }
    }
    if (fired > 0) {
      try { await sendTelegramAlert(`🔔 Рутинные пуши разосланы: ${fired}`); } catch {}
    }
  }
}
