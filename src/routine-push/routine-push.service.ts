import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { PushService } from '../push/push.service';
import { ChatService } from '../chat/chat.service';
import { RoutineStore, RoutineRow, ENERGY_PROMPT } from './routine-store.service';
import { LanguageService } from '../common/services/language.service';
import { routineMsg } from './routine-messages';
import { sendTelegramAlert } from '../common/telegram-alert';

const RAYA_ID = '14';

/**
 * Стабильный ключ энерго-рутины. НЕ 'energy_of_day': по `daily:<assistantId>`
 * app-widget.controller.ts проверяет, включена ли энергия дня (фикс 2026-08-23 —
 * до него гейт смотрел на 'energy_of_day', которого не было ни у кого, и блок
 * не отдавался ни разу). Любой другой ключ вернёт тот баг.
 *
 * Опознание идёт по нему, а не по заголовку: заголовок локализован, сравнение
 * с русской строкой сломалось бы молча.
 */
const ENERGY_KIND = `daily:${RAYA_ID}`;

@Injectable()
export class RoutinePushService implements OnModuleInit {
  private readonly logger = new Logger(RoutinePushService.name);

  constructor(
    private readonly pg: PgService,
    private readonly push: PushService,
    private readonly chat: ChatService,
    private readonly store: RoutineStore,
    private readonly language: LanguageService,
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
    const existing = (await this.store.list(userId)).find((r) => r.kind === ENERGY_KIND);
    if (existing) return existing;
    // Заголовок пишется в БД один раз при создании — берём язык на этот момент.
    // Опознание на заголовок больше не опирается, поэтому смена языка позже
    // дубля не создаст: заголовок просто останется на языке момента создания.
    const lang = await this.language.resolveUserLanguage(userId);
    return this.store.create(userId, {
      kind: ENERGY_KIND,
      title: routineMsg(lang).energyTitle,
      assistantId: RAYA_ID,
      prompt: ENERGY_PROMPT,
      sendHour: 8,
      tz: tz || (await this.store.knownTz(userId)) || 'Europe/Moscow',
      days: null,
      enabled: true,
    });
  }

  // ── Доставка одной рутины ────────────────────────────────────────────────────
  private async deliver(userId: string, assistantId: string, prompt: string, title?: string, kind?: string): Promise<number> {
    const text = await this.chat.generateAgentReply(userId, assistantId, prompt);
    if (!text || !text.trim()) {
      this.logger.warn(`routine deliver: empty text for ${userId} / assistant ${assistantId}`);
      return 0;
    }
    const lang = await this.language.resolveUserLanguage(userId);
    const msg = routineMsg(lang);
    const agentNum = /^\d+$/.test(assistantId) ? parseInt(assistantId, 10) : null;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'ai', $2, $3, 'text')`,
      [`${userId}_${assistantId}`, agentNum, text],
    );
    const name = await this.assistantName(assistantId, lang);
    const body = text.replace(/[#*_`>\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 130);
    const isEnergy = kind === ENERGY_KIND;
    return this.push.sendPush(userId, {
      title: isEnergy ? msg.energyTitle : `${title || msg.reminder} · ${name} ✨`,
      body,
      url: `/chat?assistant=${assistantId}`,
      tag: `routine_${assistantId}`,
    });
  }

  private async assistantName(assistantId: string, lang: string): Promise<string> {
    const fallback = routineMsg(lang).assistant;
    if (!/^\d+$/.test(assistantId)) return fallback;
    try {
      const r = await this.pg.query('SELECT COALESCE(display_name, name) AS n FROM agents WHERE id = $1', [parseInt(assistantId, 10)]);
      return r.rows[0]?.n || fallback;
    } catch { return fallback; }
  }

  // «Проверить сейчас»: генерит и шлёт немедленно конкретную рутину.
  async fireNow(userId: string, routineId: string): Promise<{ delivered: number } | null> {
    const r = await this.store.getById(userId, routineId);
    if (!r) return null;
    const delivered = await this.deliver(userId, r.assistantId, r.prompt, r.title, r.kind);
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
        const n = await this.deliver(r.user_id, r.assistant_id, r.prompt, r.title, r.kind);
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
