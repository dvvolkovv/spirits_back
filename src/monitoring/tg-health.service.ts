import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import { PgService } from '../common/services/pg.service';
import { SyntheticService } from './synthetic.service';

/**
 * Health-мониторинг Telegram-бота.
 *
 * До этого сервиса бот не был покрыт ничем. Synthetic гоняет шесть сценариев по
 * my.linkeon.io, но ни один не трогает Telegram; в самом src/tg-bot двадцать с
 * лишним catch-ов пишут только в logger.warn, а единственное исходящее
 * уведомление — DM владельцу о низком балансе. Бот живёт внутри процесса
 * linkeon-api: ляжет процесс или отвалится доставка апдейтов — узнаём от
 * пользователя.
 *
 * Две независимые проверки, потому что ломаются независимо.
 *
 * 1. ДОСТАВКА (probeWebhook). Бот работает на webhook, а не на polling
 *    (TgGrammyClient.onModuleInit → setWebhook), поэтому getWebhookInfo —
 *    прямой ответ на вопрос «Telegram вообще может до нас достучаться»:
 *      - url пустой / чужой  → вебхук снесли или перебил другой инстанс,
 *                              бот глухой и getMe об этом не скажет
 *      - last_error_date свежий → Telegram пытается и не может доставить
 *      - pending_update_count растёт → апдейты копятся, мы их не разбираем
 *    Полноценный roundtrip «написать боту и дождаться ответа» здесь невозможен:
 *    бот не может писать боту, для этого нужна MTProto-сессия живого юзера.
 *    Инъекция синтетического апдейта в свой же вебхук проверяла бы всё, КРОМЕ
 *    доставки — то есть ровно мимо самого хрупкого места, — и жгла бы токены
 *    Claude на каждый прогон.
 *
 * 2. ОБРАБОТКА (checkUnanswered). Доставка живая, а ответы не уходят — это
 *    отдельный класс отказов, самый неприятный из которых тихий: в
 *    handleMessage чат берётся под pg_try_advisory_lock, и если лок залип
 *    (упал воркер, не отпустив), каждое следующее сообщение получает «⏳
 *    Минутку», пишется в БД и возвращается БЕЗ единого сигнала. Чат молчит
 *    вечно. Проверка идёт по answer_expected_at — отметке «бот обязан был
 *    ответить», которую ставит сам бот в момент решения (см. миграцию
 *    004_tg_bot_answer_watch.sql).
 *
 * Результат probeWebhook пишется в synthetic_runs сценарием tg_webhook, чтобы
 * бот появился в общей таблице мониторинга рядом с остальными путями.
 */

const UNANSWERED_MINUTES = Number(process.env.TG_UNANSWERED_ALERT_MIN || 15);
const PENDING_UPDATES_MAX = Number(process.env.TG_PENDING_UPDATES_MAX || 20);
// Telegram держит last_error_date, пока ошибка не сменится успехом, поэтому
// старую запись игнорируем — иначе алерт залипнет после уже прошедшего сбоя.
const WEBHOOK_ERROR_FRESH_MIN = Number(process.env.TG_WEBHOOK_ERROR_FRESH_MIN || 30);
const ALERT_COOLDOWN_HOURS = Number(process.env.TG_HEALTH_ALERT_COOLDOWN_H || 3);

export interface TgHealthOverview {
  generatedAt: string;
  configured: boolean;
  webhook: {
    healthy: boolean | null; // null = настроен, но ещё не пробовали
    url: string | null; // с вырезанным секретом
    pendingUpdateCount: number | null;
    lastErrorMessage: string | null;
    lastErrorAt: string | null;
    checkedAt: string | null;
    error: string | null;
    consecutiveFailures: number;
  };
  unanswered: {
    thresholdMinutes: number;
    stuckChats: number;
    checkedAt: string | null;
    chats: Array<{ chatId: string; title: string | null; waitingMinutes: number }>;
  };
}

@Injectable()
export class TgHealthService {
  private readonly log = new Logger(TgHealthService.name);

  private webhookHealthy: boolean | null = null;
  private webhookUrl: string | null = null;
  private pendingUpdateCount: number | null = null;
  private lastErrorMessage: string | null = null;
  private lastErrorAt: string | null = null;
  private webhookCheckedAt: string | null = null;
  private webhookError: string | null = null;
  private consecutiveFailures = 0;
  private lastWebhookAlertAt: Date | null = null;

  private stuckChats: Array<{ chatId: string; title: string | null; waitingMinutes: number }> = [];
  private unansweredCheckedAt: string | null = null;
  private lastUnansweredAlertAt: Date | null = null;
  private unansweredWasStuck = false;

  constructor(
    @Optional() private readonly pg?: PgService,
    @Optional() private readonly synthetic?: SyntheticService,
  ) {}

  private configured(): boolean {
    return !!process.env.TG_BOT_TOKEN;
  }

  /** Ожидаемый вебхук — тот же расчёт, что в TgGrammyClient.onModuleInit. */
  private expectedWebhookUrl(): string | null {
    const secret = process.env.TG_WEBHOOK_URL_SECRET;
    if (!secret) return null;
    const base = process.env.TG_WEBHOOK_BASE_URL || 'https://my.linkeon.io';
    return `${base}/webhook/telegram/${secret}`;
  }

  /** URL с вырезанным секретом — он уходит в БД, в API и в Telegram-алерт. */
  private maskUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    return url.replace(/\/webhook\/telegram\/.+$/, '/webhook/telegram/***');
  }

  @Cron('0 */5 * * * *')
  async scheduledWebhook(): Promise<void> {
    await this.probeWebhook();
  }

  @Cron('30 */5 * * * *')
  async scheduledUnanswered(): Promise<void> {
    await this.checkUnanswered();
  }

  async probeWebhook(): Promise<void> {
    if (!this.configured()) {
      this.webhookHealthy = null;
      this.webhookError = 'TG_BOT_TOKEN not set';
      return;
    }
    const token = process.env.TG_BOT_TOKEN as string;
    const started = Date.now();
    let failure: string | null = null;
    try {
      const resp = await axios.get(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
        timeout: 15_000,
        validateStatus: () => true,
      });
      this.webhookCheckedAt = new Date().toISOString();

      if (resp.status !== 200 || resp.data?.ok !== true) {
        // 401 здесь = токен отозван/протух: бот мёртв целиком, не только вебхук.
        const hint = resp.status === 401 ? ' (TG_BOT_TOKEN отозван?)' : '';
        failure = `getWebhookInfo HTTP ${resp.status}${hint}: ${JSON.stringify(resp.data).slice(0, 200)}`;
      } else {
        const info = resp.data.result || {};
        this.webhookUrl = this.maskUrl(info.url);
        this.pendingUpdateCount = Number(info.pending_update_count ?? 0);
        this.lastErrorMessage = info.last_error_message || null;
        this.lastErrorAt = info.last_error_date
          ? new Date(info.last_error_date * 1000).toISOString()
          : null;
        failure = this.evaluate(info);
      }
    } catch (e: any) {
      this.webhookCheckedAt = new Date().toISOString();
      failure = e?.message || 'network error';
    }

    const durationMs = Date.now() - started;
    // Сценарий в общей таблице synthetic: бот виден рядом с остальными путями.
    await this.synthetic?.record('tg_webhook', !failure, durationMs, failure);

    if (failure) await this.markWebhookFailure(failure);
    else await this.markWebhookSuccess();
  }

  /**
   * Разбор getWebhookInfo. Возвращает описание проблемы или null.
   * Порядок проверок — от самой тяжёлой поломки к самой лёгкой.
   */
  private evaluate(info: any): string | null {
    const expected = this.expectedWebhookUrl();
    const actual: string = info.url || '';

    if (!actual) {
      return 'вебхук не зарегистрирован (url пустой) — бот не получает сообщения';
    }
    if (expected && actual !== expected) {
      return `вебхук указывает не на нас: ${this.maskUrl(actual)} — сообщения уходят чужому инстансу`;
    }
    if (info.last_error_date) {
      const ageMin = (Date.now() - info.last_error_date * 1000) / 60000;
      if (ageMin < WEBHOOK_ERROR_FRESH_MIN) {
        return `Telegram не может доставить апдейты (${Math.round(ageMin)} мин назад): ${String(info.last_error_message || 'без описания').slice(0, 200)}`;
      }
    }
    const pending = Number(info.pending_update_count ?? 0);
    if (pending > PENDING_UPDATES_MAX) {
      return `очередь недоставленных апдейтов ${pending} (порог ${PENDING_UPDATES_MAX}) — апдейты копятся, бот их не разбирает`;
    }
    return null;
  }

  private async markWebhookSuccess(): Promise<void> {
    const wasDown = this.webhookHealthy === false;
    const failedFor = this.consecutiveFailures;
    this.webhookHealthy = true;
    this.webhookError = null;
    this.consecutiveFailures = 0;
    if (wasDown) {
      this.log.log(`tg webhook recovered after ${failedFor} failed probe(s)`);
      await this.sendWebhookAlert(
        `<b>✅ Telegram-бот снова принимает сообщения</b>\n` +
          `Вебхук отвечает после ${failedFor} неудачных проб(ы) подряд.`,
        true,
      );
      this.lastWebhookAlertAt = null;
    }
  }

  private async markWebhookFailure(error: string): Promise<void> {
    this.webhookHealthy = false;
    this.webhookError = error;
    this.consecutiveFailures += 1;
    this.log.error(`tg webhook probe failed (#${this.consecutiveFailures}): ${error}`);
    await this.sendWebhookAlert(
      `<b>🔴 Telegram-бот не принимает сообщения</b>\n` +
        `Проблема: ${this.escape(error.slice(0, 400))}\n` +
        `Проб подряд с ошибкой: <b>${this.consecutiveFailures}</b>\n` +
        `Пользователи пишут боту и не получают ничего. Проверить TG_BOT_TOKEN, ` +
        `TG_WEBHOOK_* и доступность вебхука снаружи.`,
      this.consecutiveFailures === 1,
    );
  }

  /**
   * Чаты, где бот собирался ответить и не ответил.
   *
   * Отметку answer_expected_at ставит сам бот после shouldRespond()===true и в
   * busy-skip. Сообщение считается «отвисшим», если после отметки в ТОМ ЖЕ чате
   * появилась любая assistant-строка: чат жив, а отдельная потеря сообщения —
   * не то, ради чего будят человека ночью. Ищем именно замолчавшие чаты.
   *
   * Нижняя граница в сутки: не поднимать вечно древние висяки (после разбора
   * инцидента они всё равно останутся в таблице) и не сканировать всю историю.
   */
  async checkUnanswered(): Promise<void> {
    if (!this.pg) return;
    try {
      const r = await this.pg.query(
        `SELECT m.tg_chat_id,
                c.tg_chat_title,
                EXTRACT(EPOCH FROM (now() - min(m.answer_expected_at))) / 60 AS waiting_minutes
           FROM tg_bot_messages m
           JOIN tg_bot_configs c ON c.id = m.config_id
          WHERE m.answer_expected_at IS NOT NULL
            AND m.answer_expected_at < now() - make_interval(mins => $1::int)
            AND m.answer_expected_at > now() - interval '24 hours'
            AND NOT EXISTS (
                  SELECT 1 FROM tg_bot_messages a
                   WHERE a.tg_chat_id = m.tg_chat_id
                     AND a.role = 'assistant'
                     AND a.created_at > m.answer_expected_at
                )
          GROUP BY m.tg_chat_id, c.tg_chat_title
          ORDER BY waiting_minutes DESC`,
        [UNANSWERED_MINUTES],
      );
      this.unansweredCheckedAt = new Date().toISOString();
      this.stuckChats = r.rows.map((row: any) => ({
        chatId: String(row.tg_chat_id),
        title: row.tg_chat_title || null,
        waitingMinutes: Math.round(Number(row.waiting_minutes)),
      }));
    } catch (e: any) {
      this.log.error(`unanswered check failed: ${e.message}`);
      return;
    }

    if (this.stuckChats.length === 0) {
      if (this.unansweredWasStuck) {
        this.unansweredWasStuck = false;
        this.lastUnansweredAlertAt = null;
        await this.sendUnansweredAlert(
          `<b>✅ Telegram-бот: зависших чатов не осталось</b>\nВсе ожидавшие ответа получили его.`,
          true,
        );
      }
      return;
    }

    const firstStuck = !this.unansweredWasStuck;
    this.unansweredWasStuck = true;
    const lines = this.stuckChats.slice(0, 5).map(
      (c) => `• ${this.escape(c.title || `chat ${c.chatId}`)} — ждёт ${c.waitingMinutes} мин`,
    );
    const more = this.stuckChats.length > 5 ? `\n…и ещё ${this.stuckChats.length - 5}` : '';
    await this.sendUnansweredAlert(
      `<b>🟠 Telegram-бот молчит в ${this.stuckChats.length} чат(ах)</b>\n` +
        `${lines.join('\n')}${more}\n` +
        `Бот решил ответить и не ответил дольше ${UNANSWERED_MINUTES} мин. ` +
        `Частая причина — залипший pg_try_advisory_lock по чату: юзер получает «⏳ Минутку» на каждое сообщение.`,
      firstStuck,
    );
  }

  private async sendWebhookAlert(text: string, bypassCooldown = false): Promise<void> {
    const sent = await this.send(text, this.lastWebhookAlertAt, bypassCooldown);
    if (sent) this.lastWebhookAlertAt = new Date();
  }

  private async sendUnansweredAlert(text: string, bypassCooldown = false): Promise<void> {
    const sent = await this.send(text, this.lastUnansweredAlertAt, bypassCooldown);
    if (sent) this.lastUnansweredAlertAt = new Date();
  }

  private async send(text: string, lastAt: Date | null, bypassCooldown: boolean): Promise<boolean> {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return false;
    if (!bypassCooldown && lastAt && Date.now() - lastAt.getTime() < ALERT_COOLDOWN_HOURS * 3600_000) {
      return false;
    }
    try {
      await sendTelegramPayload({ parse_mode: 'HTML', text });
      return true;
    } catch (e: any) {
      this.log.error(`Telegram alert failed: ${e?.message || 'unknown'}`);
      return false;
    }
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  getOverview(): TgHealthOverview {
    return {
      generatedAt: new Date().toISOString(),
      configured: this.configured(),
      webhook: {
        healthy: this.webhookHealthy,
        url: this.webhookUrl,
        pendingUpdateCount: this.pendingUpdateCount,
        lastErrorMessage: this.lastErrorMessage,
        lastErrorAt: this.lastErrorAt,
        checkedAt: this.webhookCheckedAt,
        error: this.webhookError,
        consecutiveFailures: this.consecutiveFailures,
      },
      unanswered: {
        thresholdMinutes: UNANSWERED_MINUTES,
        stuckChats: this.stuckChats.length,
        checkedAt: this.unansweredCheckedAt,
        chats: this.stuckChats.slice(0, 20),
      },
    };
  }
}
