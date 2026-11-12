import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { PushService } from '../push/push.service';
import { ChatService, RelaySessionBusyError } from '../chat/chat.service';
import { RoutineStore, RoutineRow, ENERGY_PROMPT } from './routine-store.service';
import { sendTelegramAlert } from '../common/telegram-alert';

export interface DeliverResult {
  delivered: number;
  /** Relay-сессия занята: можно повторить после освобождения. */
  busy?: boolean;
  /** Генерация не завершилась успешно: пуш и обрывок не отправляются. */
  failed?: boolean;
  /** done.failReason или безопасная локальная причина cli_failure_text. */
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
  async ensureEnergyPreset(userId: string, tz?: string): Promise<RoutineRow | null> {
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
  /**
   * Отложенная доставка: человек сейчас разговаривает с этим ассистентом, и
   * agentReply честно отказал (RelaySessionBusyError) вместо пре-эмпта его
   * хода. Ждать внутри runDue нельзя — последовательный цикл встал бы всем
   * остальным рутинам, а fireNow держал бы HTTP. Поэтому повтор через 15 минут
   * таймером: цикл идёт дальше, HTTP отвечает сразу. Одна отложенная на пару
   * пользователь+ассистент. Таймер in-memory: рестарт процесса её теряет —
   * следующий плановый запуск по расписанию остаётся страховкой.
   */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();

  private async accountIsActive(userId: string): Promise<boolean> {
    const r = await this.pg.query(
      `SELECT 1 FROM user_id WHERE internal_id=$1 AND state='active' LIMIT 1`,
      [userId],
    );
    return r.rowCount === 1 || (r.rowCount == null && r.rows.length === 1);
  }

  clearRetryTimersForUser(userId: string): void {
    const prefix = `${userId}:`;
    for (const [key, timer] of this.retryTimers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.retryTimers.delete(key);
    }
  }

  private async scheduleRetry(userId: string, routineId: string): Promise<void> {
    if (!(await this.accountIsActive(userId))) return;
    const key = `${userId}:${routineId}`;
    if (this.retryTimers.has(key)) return;
    this.logger.log(`routine ${routineId} retry через 15 минут`);
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      void (async () => {
        if (!(await this.accountIsActive(userId))) return;
        // За 15 минут рутину могли удалить, выключить или изменить — берём
        // актуальную запись, а не снимок на момент busy.
        const r = await this.store.getById(userId, routineId);
        if (!r || !r.enabled) return;
        const today = this.store.localDate(r.tz, new Date());
        const prev = r.lastSentDate;
        if (!(await this.store.claimToday(routineId, today, userId))) return;
        const result = await this.deliver(
          userId, r.assistantId, r.prompt, r.title, routineId,
        );
        await this.releaseDeferred(routineId, today, prev, result);
      })().catch((e: any) => {
        // Другая ошибка не даёт автоматического retry; claim остаётся на сегодня.
        this.logger.warn(`routine ${routineId} retry failed: ${e?.name || 'Error'}`);
      });
    }, 15 * 60 * 1000);
    timer.unref?.();
    this.retryTimers.set(key, timer);
  }

  /** Возвращает true, если день освобождён для позднейшей попытки. */
  private async releaseDeferred(
    routineId: string,
    today: string,
    prev: string | null,
    result: DeliverResult,
  ): Promise<boolean> {
    const deferred = result.busy === true
      || (result.failed === true && result.failReason === 'preempted');
    if (!deferred) return false;
    await this.store.releaseToday(routineId, today, prev);
    this.logger.log(
      `routine ${routineId} отложена: ${result.busy ? 'занята сессия' : 'ход перебит (preempted)'}`,
    );
    return true;
  }

  private async deliver(
    userId: string,
    assistantId: string,
    prompt: string,
    title: string | undefined,
    routineId?: string,
  ): Promise<DeliverResult> {
    if (!(await this.accountIsActive(userId))) return { delivered: 0 };
    let outcome: { text: string; failed: boolean; failReason?: string };
    try {
      // Рутина — путь, где ассистент реально может позвать инструмент Linkeon
      // (картинка, рутина, календарь): AgentReplyOpts.linkeonTools — явно true.
      outcome = await this.chat.generateAgentReplyOutcome(
        userId, assistantId, prompt, undefined, { linkeonTools: true },
      );
    } catch (e: any) {
      if (e instanceof RelaySessionBusyError) {
        if (routineId) await this.scheduleRetry(userId, routineId);
        return { delivered: 0, busy: true };
      }
      // Исключение потока — не busy: release/retry автоматически не делаем.
      throw e;
    }

    const { text, failed, failReason } = outcome;
    if (failed || !text || !text.trim()) {
      const deferred = failReason === 'preempted';
      const reason = failed
        ? `ход не завершён (${failReason || 'unknown'})`
        : 'пустой ответ';
      const message = `routine deliver: ${reason} (assistant ${assistantId})`;
      if (deferred) this.logger.log(message);
      else this.logger.warn(message);
      if (deferred && routineId) await this.scheduleRetry(userId, routineId);
      return { delivered: 0, failed: true, failReason };
    }

    // Сбой генерации не отправляем человеку как сообщение ассистента.
    if (looksLikeFailure(text)) {
      this.logger.error(
        `routine deliver: ошибка генерации текстом (assistant ${assistantId}, reason=cli_failure_text)`,
      );
      return { delivered: 0, failed: true, failReason: 'cli_failure_text' };
    }

    const agentNum = /^\d+$/.test(assistantId) ? parseInt(assistantId, 10) : null;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       SELECT $1, 'ai', $2, $3, 'text'
       WHERE EXISTS (SELECT 1 FROM user_id WHERE internal_id=$4 AND state='active')`,
      [`${userId}_${assistantId}`, agentNum, text, userId],
    );
    if (!(await this.accountIsActive(userId))) return { delivered: 0 };
    const name = await this.assistantName(assistantId);
    const body = text.replace(/[#*_`>\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 130);
    const isEnergy = assistantId === RAYA_ID && (title === 'Энергия дня' || !title);
    const delivered = await this.push.sendPush(userId, {
      title: isEnergy ? 'Энергия дня от Райи 🌅' : `${title || 'Напоминание'} · ${name} ✨`,
      body,
      url: `/chat?assistant=${assistantId}`,
      tag: `routine_${assistantId}`,
    });
    // delivered=0 здесь означает «подписок/успешных отправок нет», не failure генерации.
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
  async fireNow(userId: string, routineId: string): Promise<DeliverResult | null> {
    if (!(await this.accountIsActive(userId))) return null;
    const r = await this.store.getById(userId, routineId);
    if (!r) return null;
    return this.deliver(userId, r.assistantId, r.prompt, r.title, routineId);
  }

  // ── Крон: раз в час на :00 ───────────────────────────────────────────────────
  @Cron('0 0 * * * *')
  async runDue() {
    if (process.env.ROUTINE_PUSH_DISABLED === 'true') return;
    let rows: Awaited<ReturnType<RoutineStore['listEnabled']>>;
    try { rows = await this.store.listEnabled(); }
    catch (e: any) { this.logger.error(`runDue query failed: ${e?.name || 'Error'}`); return; }

    const now = new Date();
    let fired = 0;
    for (const r of rows) {
      try {
        if (!this.store.scheduledToday(r.days, r.tz, now)) continue;         // не сегодня по дням недели
        if (this.store.localHour(r.tz, now) < r.send_hour) continue;         // ещё не время в его tz
        const today = this.store.localDate(r.tz, now);
        if (r.last_sent_date && this.store.toISO(r.last_sent_date) === today) continue;
        const prev = r.last_sent_date ? this.store.toISO(r.last_sent_date) : null;
        if (!(await this.store.claimToday(r.id, today, r.user_id))) continue;

        const result = await this.deliver(
          r.user_id, r.assistant_id, r.prompt, r.title, r.id,
        );
        if (await this.releaseDeferred(r.id, today, prev, result)) continue;
        if (result.failed) {
          // День остаётся застолбленным: не-preempted failure не повторяем автоматически.
          this.logger.log(
            `routine ${r.id} сбой генерации, без повтора (reason=${result.failReason || 'unknown'})`,
          );
          continue;
        }
        if (result.delivered > 0) fired++;
        this.logger.log(
          `routine ${r.id} доставка завершена (assistant ${r.assistant_id}, delivered=${result.delivered})`,
        );
      } catch (e: any) {
        this.logger.error(`runDue deliver failed for routine ${r?.id || 'unknown'}: ${e?.name || 'Error'}`);
      }
    }
    if (fired > 0) {
      try { await sendTelegramAlert(`🔔 Рутинные пуши разосланы: ${fired}`); } catch {}
    }
  }
}
