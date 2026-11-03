import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { PushService } from '../push/push.service';
import { ChatService } from '../chat/chat.service';
import { RoutineStore, RoutineRow, ENERGY_PROMPT } from './routine-store.service';
import { sendTelegramAlert } from '../common/telegram-alert';
import { RelaySessionBusyError } from '../chat/relay-session-busy';

/** Исход deliver(): сколько реально разослано и — если 0 — почему. */
export interface DeliverResult {
  delivered: number;
  /** Сессия релея человека (или другой рутины) занята — попробуем через час. */
  busy?: boolean;
  /** Генерация не вернула текст (сбойный, в т.ч. перебитый, ход) — пуш не ушёл. */
  failed?: boolean;
  /**
   * done.failReason, когда failed. Только 'preempted' (человек перебил ход
   * на релее) возвращает день на повтор — сессия освободится в течение
   * часа; прочее (transient_after_write, max_turns, cli_fatal и т.п.) —
   * часовой повтор не поможет, день съеден, как и у looksLikeFailure
   * (ревью 03.11, п.3). См. решение в runDue.
   */
  failReason?: string;
}

const RAYA_ID = '14';

/**
 * Похоже ли это на сбой инструмента, а не на ответ ассистента.
 *
 * Признаки взяты из того, что реально приходило: Claude CLI на неудачной аутентификации
 * возвращает «Failed to authenticate…» обычным текстом и кодом успеха. Ответ ассистента
 * такого не начинает — он на русском и от первого лица.
 *
 * ⚠️ Это пол, а не потолок: ловит известные формы. Поэтому проверка стоит в проактивном
 * канале, где цена ошибки выше (человек не просил сообщения), и НЕ подменяет собой
 * честную обработку ошибок в самом ChatService.
 */
export function looksLikeFailure(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 400) return false;   // длинный связный текст — это ответ, а не ошибка
  return [
    'failed to authenticate',
    'oauth session expired',
    'authentication_error',
    'api error:',
    'invalid authentication credentials',
    'rate limit',
    'internal server error',
  ].some((marker) => t.includes(marker));
}

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
  private async deliver(userId: string, assistantId: string, prompt: string, title?: string): Promise<DeliverResult> {
    let outcome: { text: string; failed: boolean; failReason?: string };
    try {
      // Рутина — путь, где ассистент реально может позвать инструмент Linkeon
      // (картинка, рутина, календарь): AgentReplyOpts.linkeonTools — явно true.
      // generateAgentReplyOutcome (не generateAgentReply) — нужен failReason:
      // runDue возвращает день на повтор только при 'preempted', см. там.
      outcome = await this.chat.generateAgentReplyOutcome(userId, assistantId, prompt, undefined, { linkeonTools: true });
    } catch (e) {
      // Сессия релея человека (или другой рутины) занята прямо сейчас —
      // человек в приоритете, рутину не шлём вовсе (бэклог e777aa94).
      // Вызывающий (runDue/fireNow) решает, что делать с busy — не падаем.
      if (e instanceof RelaySessionBusyError) return { delivered: 0, busy: true };
      throw e;
    }
    const { text, failed, failReason } = outcome;
    if (failed || !text || !text.trim()) {
      // Явный done.failed (в т.ч. перебитый ход, failReason: 'preempted') или
      // вовсе пустой текст: рутина — сообщение, которого человек не просил;
      // промолчать лучше, чем прислать обрывок от его имени. runDue решает,
      // возвращать ли день на повтор (только для 'preempted' — остальное
      // часовой повтор не исправит, см. там).
      //
      // WARN — если это НЕ ожидаемое «перебили» (preempted): для него
      // достаточно info, это нормальный исход конкуренции за сессию
      // (ревью 03.11), а не сбой.
      const deferred = failReason === 'preempted';
      const emptyTextMsg = `routine deliver: empty text for ${userId} / assistant ${assistantId}`;
      if (deferred) this.logger.log(emptyTextMsg); else this.logger.warn(emptyTextMsg);
      return { delivered: 0, failed: true, failReason };
    }
    // ⚠️ Сбой генерации НЕ отправляем человеку как сообщение ассистента.
    //
    // 12.10.2026 в 02:00 сессия Claude CLI не обновилась, ошибка вернулась ТЕКСТОМ (не
    // исключением), и владелец получил пуш от Райи с содержимым «Failed to authenticate:
    // OAuth session expired and could not be refreshed». Проверка на пустоту такое не
    // ловит: текст есть. Следующий запуск по расписанию попробует снова, а строка в логе
    // показывает, что проход был и почему не дошёл.
    //
    // НЕ failed: это сбой авторизации CLI, а не «сессия освободится через
    // час» — часовой повтор на сломанной авторизации только слал бы алерты
    // без толку (runDue день не возвращает, см. там).
    if (looksLikeFailure(text)) {
      this.logger.error(`routine deliver: ОТМЕНЕНО, генерация вернула ошибку текстом `
        + `для ${userId} / assistant ${assistantId}: ${text.slice(0, 160)}`);
      return { delivered: 0 };
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
    const delivered = await this.push.sendPush(userId, {
      title: isEnergy ? 'Энергия дня от Райи 🌅' : `${title || 'Напоминание'} · ${name} ✨`,
      body,
      url: `/chat?assistant=${assistantId}`,
      tag: `routine_${assistantId}`,
    });
    return { delivered };
  }

  private async assistantName(assistantId: string): Promise<string> {
    if (!/^\d+$/.test(assistantId)) return 'ассистент';
    try {
      const r = await this.pg.query('SELECT COALESCE(display_name, name) AS n FROM agents WHERE id = $1', [parseInt(assistantId, 10)]);
      return r.rows[0]?.n || 'ассистент';
    } catch { return 'ассистент'; }
  }

  // «Проверить сейчас»: генерит и шлёт немедленно конкретную рутину.
  // busy/failed — честно наверх (контроллер), а не «сгенерировали, но пуш не
  // доставлен — включи уведомления» (это deliver() умел бы и раньше).
  async fireNow(userId: string, routineId: string): Promise<DeliverResult | null> {
    const r = await this.store.getById(userId, routineId);
    if (!r) return null;
    return this.deliver(userId, r.assistantId, r.prompt, r.title);
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
        const prev = r.last_sent_date; // запоминаем ДО claimToday — releaseToday вернёт именно это
        if (!(await this.store.claimToday(r.id, today))) continue;           // уже застолбили
        const result = await this.deliver(r.user_id, r.assistant_id, r.prompt, r.title);
        if (result.busy || (result.failed && result.failReason === 'preempted')) {
          // Сессия была занята, или человек перебил фоновый ход на релее —
          // не наша вина, сессия освободится в течение часа: день НЕ
          // считается отправленным, следующий часовой крон попробует снова
          // (бэклог e777aa94, ревью 03.11 п.3). Лог — по id рутины (uuid),
          // без user_id (у старых аккаунтов это телефон) и без заголовка.
          await this.store.releaseToday(r.id, today, prev);
          this.logger.log(`routine ${r.id} отложена: ${result.busy ? 'занята сессия' : 'ход перебит'} `
            + `(assistant ${r.assistant_id})`);
          continue;
        }
        if (result.failed) {
          // Сбой НЕ из-за занятости/перебития (CLI, лимит ходов, запись
          // могла уже пройти) — часовой повтор не поможет: день съеден, как
          // и у looksLikeFailure. Тот же формат лога — без номеров.
          this.logger.log(`routine ${r.id} сбой генерации, без повтора (assistant ${r.assistant_id})`);
          continue;
        }
        if (result.delivered > 0) fired++; // сводка в TG — реально доставленные, не все попытки
        this.logger.log(`routine "${r.title}" sent to ${r.user_id} (assistant ${r.assistant_id}, delivered=${result.delivered})`);
      } catch (e: any) {
        this.logger.error(`runDue deliver failed for ${r?.user_id}: ${e.message}`);
      }
    }
    if (fired > 0) {
      try { await sendTelegramAlert(`🔔 Рутинные пуши разосланы: ${fired}`); } catch {}
    }
  }
}
