import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { EventsService } from '../events/events.service';
import axios from 'axios';

/**
 * SMS Aero passive health monitoring.
 *
 * Doesn't actively send SMS — instead:
 * - Counts sms_aero_failure / sms_aero_success events emitted from
 *   AuthService.sendSms (cheap, accurate)
 * - Pulls balance from SMS Aero's /v2/balance API once per hour
 * - Sends a Telegram alert when balance falls below threshold
 *
 * Telegram credentials reused from Alertmanager config (no new env).
 * Cached balance lives in memory so the admin endpoint doesn't hit
 * Aero on every page load.
 */

interface BalanceSnapshot {
  rub: number | null;
  fetchedAt: string;
  error: string | null;
}

const ALERT_THRESHOLD_RUB = Number(process.env.SMS_BALANCE_ALERT_THRESHOLD || 500);
const ALERT_COOLDOWN_HOURS = Number(process.env.SMS_BALANCE_ALERT_COOLDOWN_H || 12);
// NOTE: Telegram creds are read at call time inside maybeAlert(), not here —
// module-level process.env reads run before ConfigModule loads .env, so a
// const here would always be '' and silently disable alerts.

export interface SmsHealthOverview {
  generatedAt: string;
  balance: BalanceSnapshot;
  alertThresholdRub: number;
  success24h: number;
  failure24h: number;
  failureRatePct24h: number | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  topFailureReasons: Array<{ reason: string; count: number }>;
}

@Injectable()
export class SmsHealthService implements OnModuleInit {
  private readonly log = new Logger(SmsHealthService.name);
  private balanceCache: BalanceSnapshot = { rub: null, fetchedAt: new Date(0).toISOString(), error: null };
  private lastAlertAt: Date | null = null;

  constructor(
    private readonly pg: PgService,
    private readonly events: EventsService,
  ) {}

  async onModuleInit() {
    // Don't block app start — let cron handle subsequent refreshes.
    this.refreshBalance().catch(() => {});
  }

  // Every hour: refresh balance + alert if low.
  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    await this.refreshBalance();
    await this.maybeAlert();
  }

  private async refreshBalance(): Promise<void> {
    const login = process.env.SMSAERO_LOGIN;
    const apiKey = process.env.SMSAERO_API_KEY;
    if (!login || !apiKey) {
      this.balanceCache = { rub: null, fetchedAt: new Date().toISOString(), error: 'SMSAERO_LOGIN/API_KEY not set' };
      return;
    }
    try {
      const r = await axios.get('https://gate.smsaero.ru/v2/balance', {
        auth: { username: login, password: apiKey },
        timeout: 8000,
        validateStatus: () => true,
      });
      if (r.status >= 400 || r.data?.success === false) {
        this.balanceCache = {
          rub: null, fetchedAt: new Date().toISOString(),
          error: `aero ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`,
        };
        return;
      }
      const rub = Number(r.data?.data?.balance);
      this.balanceCache = {
        rub: Number.isFinite(rub) ? rub : null,
        fetchedAt: new Date().toISOString(),
        error: null,
      };
    } catch (e: any) {
      this.balanceCache = { rub: null, fetchedAt: new Date().toISOString(), error: e?.message || 'network' };
    }
  }

  private async maybeAlert(): Promise<void> {
    const rub = this.balanceCache.rub;
    if (rub === null || rub > ALERT_THRESHOLD_RUB) return;
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
    if (!TG_TOKEN || !TG_CHAT) return;
    const now = new Date();
    if (this.lastAlertAt && (now.getTime() - this.lastAlertAt.getTime()) < ALERT_COOLDOWN_HOURS * 3600_000) {
      return;
    }
    try {
      await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT,
        parse_mode: 'HTML',
        text: `<b>⚠️ SMS Aero: низкий баланс</b>\n` +
              `Сейчас: <b>${rub.toFixed(2)} ₽</b>\n` +
              `Порог: ${ALERT_THRESHOLD_RUB} ₽\n` +
              `Пополнить: https://smsaero.ru/cabinet/`,
      }, { timeout: 8000 });
      this.lastAlertAt = now;
      this.log.warn(`SMS Aero balance low: ${rub} RUB — Telegram alert sent`);
    } catch (e: any) {
      this.log.error(`Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }

  async getOverview(): Promise<SmsHealthOverview> {
    const stats = await this.pg.query(
      `SELECT
         COUNT(*) FILTER (WHERE name = 'sms_aero_success')::int AS success_count,
         COUNT(*) FILTER (WHERE name = 'sms_aero_failure')::int AS failure_count
       FROM events
       WHERE name IN ('sms_aero_success', 'sms_aero_failure')
         AND ts >= now() - interval '24 hours'`,
    );
    const lastFail = await this.pg.query(
      `SELECT ts, props->>'reason' AS reason
       FROM events
       WHERE name = 'sms_aero_failure'
       ORDER BY ts DESC LIMIT 1`,
    );
    const reasons = await this.pg.query(
      `SELECT COALESCE(props->>'reason', 'unknown') AS reason, COUNT(*)::int AS count
       FROM events
       WHERE name = 'sms_aero_failure'
         AND ts >= now() - interval '7 days'
       GROUP BY 1 ORDER BY count DESC LIMIT 5`,
    );

    const success24h = parseInt(stats.rows[0]?.success_count || '0', 10);
    const failure24h = parseInt(stats.rows[0]?.failure_count || '0', 10);
    const total = success24h + failure24h;

    return {
      generatedAt: new Date().toISOString(),
      balance: this.balanceCache,
      alertThresholdRub: ALERT_THRESHOLD_RUB,
      success24h,
      failure24h,
      failureRatePct24h: total > 0 ? (failure24h / total) * 100 : null,
      lastFailureAt: lastFail.rows[0]?.ts instanceof Date
        ? lastFail.rows[0].ts.toISOString()
        : (lastFail.rows[0]?.ts || null),
      lastFailureReason: lastFail.rows[0]?.reason || null,
      topFailureReasons: reasons.rows.map((r: any) => ({ reason: r.reason, count: r.count })),
    };
  }
}
