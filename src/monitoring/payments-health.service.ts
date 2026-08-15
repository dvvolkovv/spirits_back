import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import { PgService } from '../common/services/pg.service';
import { SyntheticService } from './synthetic.service';

/**
 * Health-мониторинг приёма платежей.
 *
 * Инцидент 14–15.08.2026: магазин ЮKassa перевели в status=disabled,
 * POST /v3/payments начал отдавать 403, пользователи получали «Internal server
 * error». Узнали через двое суток от владельца. Ни одна существующая проверка
 * не могла этого поймать: synthetic не трогает платёжного провайдера, а в БД не
 * появлялось ни строки — payments пишется только ПОСЛЕ успешного ответа.
 *
 * Предсказать отключение нельзя: провайдер не отдаёт по API ни предупреждений,
 * ни сроков документов. Задача — сократить время обнаружения с суток до минут.
 *
 * Оплата ломается тремя независимыми способами, поэтому проверки три.
 *
 * 1. ПРОВАЙДЕР (probeShop). GET /v3/me раз в 5 минут, смотрим status.
 *    Ловит отключённый магазин, отозванные ключи (401), лежащий API. Главное —
 *    РАБОТАЕТ БЕЗ ТРАФИКА: 12–14 августа попыток оплаты просто не было, и любая
 *    метрика по трафику молчала бы совершенно законно.
 *
 * 2. НАШ КОД (checkAttempts). Проба зелёная не значит, что оплата работает:
 *    упасть можем мы сами — на вставке в payments, на резолве пакета. Считаем
 *    подряд идущие неудачные попытки в payment_attempts.
 *
 * 3. ВОРОНКА (checkFunnel). Платежи создаются, ссылка отдаётся, а до succeeded
 *    не доходит никто — сломан коллбэк или возврат с формы. Первые две проверки
 *    при этом зелёные. Условие «попытки были» обязательно: при 1–2 платежах в
 *    сутки безусловное «нет оплат за 48 часов» — гарантированный ложняк.
 */

const SHOP_PROBE_TIMEOUT_MS = 15_000;
// Сколько неудач подряд считать поломкой. Единичная — это карта пользователя
// или его отменённый переход, а не авария.
const FAIL_STREAK_ALERT = Number(process.env.PAYMENTS_FAIL_STREAK || 3);
// Окно воронки. Меньше суток брать нельзя: человек может открыть форму вечером,
// а оплатить утром, и «зависший» pending — норма, а не сбой.
const FUNNEL_WINDOW_HOURS = Number(process.env.PAYMENTS_FUNNEL_WINDOW_H || 24);
const FUNNEL_MIN_ATTEMPTS = Number(process.env.PAYMENTS_FUNNEL_MIN_ATTEMPTS || 3);
const ALERT_COOLDOWN_HOURS = Number(process.env.PAYMENTS_ALERT_COOLDOWN_H || 3);

export interface PaymentsHealthOverview {
  generatedAt: string;
  shop: {
    configured: boolean;
    healthy: boolean | null;
    status: string | null; // enabled | disabled | …
    accountId: string | null;
    checkedAt: string | null;
    error: string | null;
    consecutiveFailures: number;
  };
  attempts: {
    failStreak: number;
    threshold: number;
    lastError: string | null;
    lastFailureAt: string | null;
    checkedAt: string | null;
  };
  funnel: {
    windowHours: number;
    created: number;
    succeeded: number;
    healthy: boolean | null; // null = слишком мало попыток, чтобы судить
    checkedAt: string | null;
  };
}

@Injectable()
export class PaymentsHealthService {
  private readonly log = new Logger(PaymentsHealthService.name);

  private shopHealthy: boolean | null = null;
  private shopStatus: string | null = null;
  private accountId: string | null = null;
  private shopCheckedAt: string | null = null;
  private shopError: string | null = null;
  private consecutiveFailures = 0;
  private lastShopAlertAt: Date | null = null;

  private failStreak = 0;
  private lastAttemptError: string | null = null;
  private lastFailureAt: string | null = null;
  private attemptsCheckedAt: string | null = null;
  private lastAttemptsAlertAt: Date | null = null;
  private attemptsWasBroken = false;

  private funnelCreated = 0;
  private funnelSucceeded = 0;
  private funnelHealthy: boolean | null = null;
  private funnelCheckedAt: string | null = null;
  private lastFunnelAlertAt: Date | null = null;

  constructor(
    @Optional() private readonly pg?: PgService,
    @Optional() private readonly synthetic?: SyntheticService,
  ) {}

  private configured(): boolean {
    return !!process.env.YOOKASSA_SHOP_ID && !!process.env.YOOKASSA_SECRET_KEY;
  }

  @Cron('0 */5 * * * *')
  async scheduledShop(): Promise<void> {
    await this.probeShop();
  }

  @Cron('30 */5 * * * *')
  async scheduledAttempts(): Promise<void> {
    await this.checkAttempts();
  }

  @Cron('0 17 * * * *')
  async scheduledFunnel(): Promise<void> {
    await this.checkFunnel();
  }

  /**
   * Слой 1. GET /v3/me — read-only, ничего не создаёт и не стоит денег.
   * Именно этим запросом была найдена причина инцидента 14.08.
   */
  async probeShop(): Promise<void> {
    if (!this.configured()) {
      this.shopHealthy = null;
      this.shopError = 'YOOKASSA_SHOP_ID/SECRET_KEY не заданы';
      return;
    }
    const started = Date.now();
    let failure: string | null = null;
    try {
      const resp = await axios.get('https://api.yookassa.ru/v3/me', {
        auth: {
          username: process.env.YOOKASSA_SHOP_ID as string,
          password: process.env.YOOKASSA_SECRET_KEY as string,
        },
        timeout: SHOP_PROBE_TIMEOUT_MS,
        validateStatus: () => true,
      });
      this.shopCheckedAt = new Date().toISOString();

      if (resp.status === 401) {
        failure = 'ключи отвергнуты (HTTP 401) — YOOKASSA_SECRET_KEY отозван или заменён';
      } else if (resp.status !== 200) {
        failure = `HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`;
      } else {
        this.accountId = resp.data?.account_id ?? null;
        this.shopStatus = resp.data?.status ?? null;
        if (this.shopStatus !== 'enabled') {
          failure = `магазин в статусе «${this.shopStatus}» — приём платежей запрещён провайдером`;
        }
      }
    } catch (e: any) {
      this.shopCheckedAt = new Date().toISOString();
      failure = e?.message || 'сеть недоступна';
    }

    await this.synthetic?.record('yookassa_shop', !failure, Date.now() - started, failure);

    if (failure) {
      this.shopHealthy = false;
      this.shopError = failure;
      this.consecutiveFailures += 1;
      this.log.error(`yookassa shop probe failed (#${this.consecutiveFailures}): ${failure}`);
      const sent = await this.send(
        `<b>🔴 Приём платежей не работает</b>\n` +
          `${this.escape(failure)}\n` +
          `Магазин: <code>${this.escape(this.accountId || process.env.YOOKASSA_SHOP_ID || '—')}</code>\n` +
          `Проб подряд с ошибкой: <b>${this.consecutiveFailures}</b>\n` +
          `Пользователи не могут пополнить баланс. Причину смотреть в личном кабинете ЮKassa.`,
        this.lastShopAlertAt,
        this.consecutiveFailures === 1,
      );
      if (sent) this.lastShopAlertAt = new Date();
    } else {
      const wasDown = this.shopHealthy === false;
      this.shopHealthy = true;
      this.shopError = null;
      const failedFor = this.consecutiveFailures;
      this.consecutiveFailures = 0;
      if (wasDown) {
        this.log.log(`yookassa shop recovered after ${failedFor} failed probe(s)`);
        await this.send(
          `<b>✅ Приём платежей восстановлен</b>\nМагазин снова <code>enabled</code> после ${failedFor} неудачных проб(ы).`,
          null,
          true,
        );
        this.lastShopAlertAt = null;
      }
    }
  }

  /**
   * Слой 2. Подряд идущие неудачи в payment_attempts.
   *
   * Считаем именно СЕРИЮ с конца, а не долю за окно: доля размывается редким
   * трафиком (1–2 платежа в сутки), а серия ловит аварию с третьей попытки
   * независимо от того, сколько их было вчера.
   */
  async checkAttempts(): Promise<void> {
    if (!this.pg) return;
    try {
      const r = await this.pg.query(
        `SELECT ok, error, created_at FROM payment_attempts ORDER BY created_at DESC LIMIT 20`,
      );
      this.attemptsCheckedAt = new Date().toISOString();
      let streak = 0;
      for (const row of r.rows) {
        if (row.ok) break;
        streak += 1;
        if (streak === 1) {
          this.lastAttemptError = row.error ? String(row.error).slice(0, 300) : null;
          this.lastFailureAt = row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at);
        }
      }
      this.failStreak = streak;
    } catch (e: any) {
      this.log.error(`payment attempts check failed: ${e.message}`);
      return;
    }

    if (this.failStreak >= FAIL_STREAK_ALERT) {
      const first = !this.attemptsWasBroken;
      this.attemptsWasBroken = true;
      const sent = await this.send(
        `<b>🔴 Пополнение падает у пользователей</b>\n` +
          `Неудачных попыток подряд: <b>${this.failStreak}</b> (порог ${FAIL_STREAK_ALERT})\n` +
          `Последняя ошибка: <code>${this.escape(this.lastAttemptError || '—')}</code>\n` +
          `Время: ${this.lastFailureAt || '—'}`,
        this.lastAttemptsAlertAt,
        first,
      );
      if (sent) this.lastAttemptsAlertAt = new Date();
    } else if (this.attemptsWasBroken && this.failStreak === 0) {
      this.attemptsWasBroken = false;
      this.lastAttemptsAlertAt = null;
      await this.send('<b>✅ Пополнение снова проходит</b>\nПоследняя попытка успешна.', null, true);
    }
  }

  /**
   * Слой 3. Созданные платежи не доходят до succeeded.
   *
   * Оба условия обязательны: попыток должно быть достаточно (иначе тихие сутки
   * = ложная тревога) и успешных ровно ноль (один успех означает, что путь
   * рабочий, а остальные — обычные брошенные корзины).
   */
  async checkFunnel(): Promise<void> {
    if (!this.pg) return;
    try {
      const r = await this.pg.query(
        `SELECT count(*)::int AS created,
                count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded
           FROM payments
          WHERE created_at > now() - make_interval(hours => $1::int)`,
        [FUNNEL_WINDOW_HOURS],
      );
      this.funnelCheckedAt = new Date().toISOString();
      this.funnelCreated = Number(r.rows[0]?.created ?? 0);
      this.funnelSucceeded = Number(r.rows[0]?.succeeded ?? 0);
    } catch (e: any) {
      this.log.error(`payment funnel check failed: ${e.message}`);
      return;
    }

    if (this.funnelCreated < FUNNEL_MIN_ATTEMPTS) {
      this.funnelHealthy = null; // судить не по чему
      return;
    }
    const broken = this.funnelSucceeded === 0;
    this.funnelHealthy = !broken;
    if (broken) {
      const sent = await this.send(
        `<b>🟠 Платежи создаются, но ни один не оплачен</b>\n` +
          `За ${FUNNEL_WINDOW_HOURS} ч: создано <b>${this.funnelCreated}</b>, успешных <b>0</b>.\n` +
          `Провайдер и создание платежа исправны — значит сломан возврат с формы или коллбэк.`,
        this.lastFunnelAlertAt,
        false,
      );
      if (sent) this.lastFunnelAlertAt = new Date();
    } else {
      this.lastFunnelAlertAt = null;
    }
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

  getOverview(): PaymentsHealthOverview {
    return {
      generatedAt: new Date().toISOString(),
      shop: {
        configured: this.configured(),
        healthy: this.shopHealthy,
        status: this.shopStatus,
        accountId: this.accountId,
        checkedAt: this.shopCheckedAt,
        error: this.shopError,
        consecutiveFailures: this.consecutiveFailures,
      },
      attempts: {
        failStreak: this.failStreak,
        threshold: FAIL_STREAK_ALERT,
        lastError: this.lastAttemptError,
        lastFailureAt: this.lastFailureAt,
        checkedAt: this.attemptsCheckedAt,
      },
      funnel: {
        windowHours: FUNNEL_WINDOW_HOURS,
        created: this.funnelCreated,
        succeeded: this.funnelSucceeded,
        healthy: this.funnelHealthy,
        checkedAt: this.funnelCheckedAt,
      },
    };
  }
}
