import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';

/**
 * OpenRouter passive balance monitoring.
 *
 * Mirrors SmsHealthService:
 *  - Polls OpenRouter's /credits endpoint hourly
 *  - Caches the most recent snapshot in memory so the admin UI doesn't
 *    pay a round-trip to openrouter.ai on every page load
 *  - Sends a Telegram alert when remaining credits fall below threshold
 *    (with a cooldown so we don't spam the chat)
 *
 * OpenRouter exposes balance as `total_credits - total_usage` in USD.
 * The /credits endpoint requires an admin Bearer token (`OPENROUTER_API_KEY`).
 * If the key is missing, the service gracefully reports "not configured"
 * instead of crashing.
 */

interface BalanceSnapshot {
  usd: number | null;        // Remaining credits = total_credits - total_usage
  totalCredits: number | null;
  totalUsage: number | null;
  fetchedAt: string;
  error: string | null;
}

// Threshold expressed in USD. OpenRouter prices are in USD and an
// ELLE-style "1000 ₽" doesn't translate cleanly here — 5 USD is roughly
// "a day of moderate traffic" for our chat usage.
const ALERT_THRESHOLD_USD = Number(process.env.OPENROUTER_BALANCE_ALERT_THRESHOLD_USD || 5);
const ALERT_COOLDOWN_HOURS = Number(process.env.OPENROUTER_BALANCE_ALERT_COOLDOWN_H || 12);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID  || '';

export interface OpenRouterHealthOverview {
  generatedAt: string;
  balance: BalanceSnapshot;
  alertThresholdUsd: number;
  configured: boolean;
}

@Injectable()
export class OpenRouterHealthService implements OnModuleInit {
  private readonly log = new Logger(OpenRouterHealthService.name);
  private balanceCache: BalanceSnapshot = {
    usd: null, totalCredits: null, totalUsage: null,
    fetchedAt: new Date(0).toISOString(), error: null,
  };
  private lastAlertAt: Date | null = null;

  async onModuleInit() {
    this.refreshBalance().catch(() => {});
  }

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    await this.refreshBalance();
    await this.maybeAlert();
  }

  private async refreshBalance(): Promise<void> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      this.balanceCache = {
        usd: null, totalCredits: null, totalUsage: null,
        fetchedAt: new Date().toISOString(),
        error: 'OPENROUTER_API_KEY not set',
      };
      return;
    }
    try {
      const r = await axios.get('https://openrouter.ai/api/v1/credits', {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 8000,
        validateStatus: () => true,
      });
      if (r.status >= 400) {
        this.balanceCache = {
          usd: null, totalCredits: null, totalUsage: null,
          fetchedAt: new Date().toISOString(),
          error: `openrouter ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`,
        };
        return;
      }
      const totalCredits = Number(r.data?.data?.total_credits);
      const totalUsage   = Number(r.data?.data?.total_usage);
      const remaining = (Number.isFinite(totalCredits) && Number.isFinite(totalUsage))
        ? totalCredits - totalUsage
        : null;
      this.balanceCache = {
        usd: remaining,
        totalCredits: Number.isFinite(totalCredits) ? totalCredits : null,
        totalUsage:   Number.isFinite(totalUsage)   ? totalUsage   : null,
        fetchedAt: new Date().toISOString(),
        error: null,
      };
    } catch (e: any) {
      this.balanceCache = {
        usd: null, totalCredits: null, totalUsage: null,
        fetchedAt: new Date().toISOString(),
        error: e?.message || 'network',
      };
    }
  }

  private async maybeAlert(): Promise<void> {
    const usd = this.balanceCache.usd;
    if (usd === null || usd > ALERT_THRESHOLD_USD) return;
    if (!TG_TOKEN || !TG_CHAT) return;
    const now = new Date();
    if (this.lastAlertAt && (now.getTime() - this.lastAlertAt.getTime()) < ALERT_COOLDOWN_HOURS * 3600_000) {
      return;
    }
    try {
      await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT,
        parse_mode: 'HTML',
        text: `<b>⚠️ OpenRouter: низкий баланс</b>\n` +
              `Осталось: <b>$${usd.toFixed(2)}</b>\n` +
              `Порог: $${ALERT_THRESHOLD_USD}\n` +
              `Пополнить: https://openrouter.ai/credits`,
      }, { timeout: 8000 });
      this.lastAlertAt = now;
      this.log.warn(`OpenRouter balance low: $${usd} — Telegram alert sent`);
    } catch (e: any) {
      this.log.error(`Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }

  async getOverview(): Promise<OpenRouterHealthOverview> {
    return {
      generatedAt: new Date().toISOString(),
      balance: this.balanceCache,
      alertThresholdUsd: ALERT_THRESHOLD_USD,
      configured: !!process.env.OPENROUTER_API_KEY,
    };
  }
}
