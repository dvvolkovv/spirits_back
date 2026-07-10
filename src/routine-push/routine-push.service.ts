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
    for (const p of [
      path.join(__dirname, 'migrations', '001_routine_pushes.sql'),
      path.join(__dirname, '..', '..', 'src', 'routine-push', 'migrations', '001_routine_pushes.sql'),
    ]) {
      try {
        if (fs.existsSync(p)) { await this.pg.query(fs.readFileSync(p, 'utf8')); this.logger.log(`routine_pushes migration applied from ${p}`); break; }
      } catch (e: any) { this.logger.error(`routine_pushes migration failed (${p}): ${e.message}`); }
    }
  }

  // ── Настройки: «энергия дня» = ежедневная рутина Райи ────────────────────────
  async getForUser(userId: string): Promise<RoutineRow | null> {
    return this.store.get(userId, RAYA_ID);
  }

  async upsert(userId: string, opts: { enabled: boolean; sendHour?: number; tz?: string }): Promise<RoutineRow> {
    return this.store.upsert(userId, RAYA_ID, { ...opts, prompt: ENERGY_PROMPT });
  }

  // ── Генерация + сохранение + пуш для одной рутины ────────────────────────────
  private async deliver(userId: string, assistantId: string, prompt: string): Promise<number> {
    const text = await this.chat.generateAgentReply(userId, assistantId, prompt);
    if (!text || !text.trim()) {
      this.logger.warn(`routine deliver: empty text for ${userId} / assistant ${assistantId}`);
      return 0;
    }
    // Проактивная реплика ассистента (без фейкового human-хода) — чтобы по тапу
    // пуша открылось прямо в чате этого ассистента.
    const agentNum = /^\d+$/.test(assistantId) ? parseInt(assistantId, 10) : null;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'ai', $2, $3, 'text')`,
      [`${userId}_${assistantId}`, agentNum, text],
    );
    const name = await this.assistantName(assistantId);
    const body = text.replace(/[#*_`>\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 130);
    return this.push.sendPush(userId, {
      title: assistantId === RAYA_ID ? 'Энергия дня от Райи 🌅' : `Сообщение от ${name} ✨`,
      body,
      url: `/chat?assistant=${assistantId}`,
      tag: `routine_${assistantId}`,
    });
  }

  private async assistantName(assistantId: string): Promise<string> {
    if (!/^\d+$/.test(assistantId)) return 'ассистента';
    try {
      const r = await this.pg.query('SELECT COALESCE(display_name, name) AS n FROM agents WHERE id = $1', [parseInt(assistantId, 10)]);
      return r.rows[0]?.n || 'ассистента';
    } catch { return 'ассистента'; }
  }

  // «Проверить сейчас»: генерит и шлёт немедленно, игнорируя время/дубль-гард.
  async fireNow(userId: string, assistantId: string = RAYA_ID): Promise<{ delivered: number }> {
    const cfg = await this.store.get(userId, assistantId);
    const prompt = cfg?.prompt || ENERGY_PROMPT;
    const delivered = await this.deliver(userId, assistantId, prompt);
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
        if (this.store.localHour(r.tz, now) < r.send_hour) continue;         // ещё не утро в его tz
        const today = this.store.localDate(r.tz, now);
        if (r.last_sent_date && this.store.toISO(r.last_sent_date) === today) continue;
        if (!(await this.store.claimToday(r.id, today))) continue;           // уже застолбили
        const n = await this.deliver(r.user_id, r.assistant_id, r.prompt);
        fired++;
        this.logger.log(`routine sent to ${r.user_id} (assistant ${r.assistant_id}, delivered=${n})`);
      } catch (e: any) {
        this.logger.error(`runDue deliver failed for ${r?.user_id}: ${e.message}`);
      }
    }
    if (fired > 0) {
      try { await sendTelegramAlert(`🌅 Рутинные пуши разосланы: ${fired}`); } catch {}
    }
  }
}
