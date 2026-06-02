import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';

/**
 * ElevenLabs passive balance monitoring.
 *
 * Mirrors SmsHealthService / OpenRouterHealthService.
 *
 * ElevenLabs counts in characters, not currency: each plan has a
 * monthly character_limit and a rolling character_count. Remaining =
 * character_limit - character_count. We surface that as "characters
 * left" and an estimated USD equivalent based on plan tier when known.
 *
 * Auth: `xi-api-key: <ELEVENLABS_API_KEY>`. The /v1/user/subscription
 * endpoint requires the `user_read` permission — workspace-scoped keys
 * (e.g. TTS-only) return 401/403 and the service falls back to a
 * graceful "needs permission" state.
 */

interface BalanceSnapshot {
  charactersLeft: number | null;
  charactersUsed: number | null;
  charactersLimit: number | null;
  tier: string | null;             // free / creator / pro / scale / enterprise
  nextResetUnix: number | null;    // when the monthly counter resets
  fetchedAt: string;
  error: string | null;
}

const ALERT_THRESHOLD_CHARS = Number(process.env.ELEVENLABS_BALANCE_ALERT_THRESHOLD || 50_000);
const ALERT_COOLDOWN_HOURS = Number(process.env.ELEVENLABS_BALANCE_ALERT_COOLDOWN_H || 12);
// NOTE: Telegram creds are read at call time inside maybeAlert(), not here —
// module-level process.env reads run before ConfigModule loads .env, so a
// const here would always be '' and silently disable alerts.

export interface ElevenLabsHealthOverview {
  generatedAt: string;
  balance: BalanceSnapshot;
  alertThresholdChars: number;
  configured: boolean;
}

@Injectable()
export class ElevenLabsHealthService implements OnModuleInit {
  private readonly log = new Logger(ElevenLabsHealthService.name);
  private balanceCache: BalanceSnapshot = {
    charactersLeft: null, charactersUsed: null, charactersLimit: null,
    tier: null, nextResetUnix: null,
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
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) {
      this.balanceCache = {
        charactersLeft: null, charactersUsed: null, charactersLimit: null,
        tier: null, nextResetUnix: null,
        fetchedAt: new Date().toISOString(),
        error: 'ELEVENLABS_API_KEY not set',
      };
      return;
    }
    try {
      const r = await axios.get('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': key },
        timeout: 8000,
        validateStatus: () => true,
      });
      if (r.status === 401 || (r.status === 403 && /missing_permissions/i.test(JSON.stringify(r.data)))) {
        this.balanceCache = {
          charactersLeft: null, charactersUsed: null, charactersLimit: null,
          tier: null, nextResetUnix: null,
          fetchedAt: new Date().toISOString(),
          error: 'API key lacks user_read permission — generate a new key with this scope to enable balance polling',
        };
        return;
      }
      if (r.status >= 400) {
        this.balanceCache = {
          charactersLeft: null, charactersUsed: null, charactersLimit: null,
          tier: null, nextResetUnix: null,
          fetchedAt: new Date().toISOString(),
          error: `elevenlabs ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`,
        };
        return;
      }
      const used  = Number(r.data?.character_count);
      const limit = Number(r.data?.character_limit);
      const left  = (Number.isFinite(used) && Number.isFinite(limit)) ? limit - used : null;
      this.balanceCache = {
        charactersLeft: left,
        charactersUsed: Number.isFinite(used)  ? used  : null,
        charactersLimit: Number.isFinite(limit) ? limit : null,
        tier: r.data?.tier ?? null,
        nextResetUnix: Number(r.data?.next_character_count_reset_unix) || null,
        fetchedAt: new Date().toISOString(),
        error: null,
      };
    } catch (e: any) {
      this.balanceCache = {
        charactersLeft: null, charactersUsed: null, charactersLimit: null,
        tier: null, nextResetUnix: null,
        fetchedAt: new Date().toISOString(),
        error: e?.message || 'network',
      };
    }
  }

  private async maybeAlert(): Promise<void> {
    const left = this.balanceCache.charactersLeft;
    if (left === null || left > ALERT_THRESHOLD_CHARS) return;
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
        text: `<b>⚠️ ElevenLabs: низкий баланс</b>\n` +
              `Осталось: <b>${left.toLocaleString('ru-RU')} символов</b>\n` +
              `Порог: ${ALERT_THRESHOLD_CHARS.toLocaleString('ru-RU')} символов\n` +
              `Пополнить: https://elevenlabs.io/app/subscription`,
      }, { timeout: 8000 });
      this.lastAlertAt = now;
      this.log.warn(`ElevenLabs balance low: ${left} chars — Telegram alert sent`);
    } catch (e: any) {
      this.log.error(`Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }

  async getOverview(): Promise<ElevenLabsHealthOverview> {
    return {
      generatedAt: new Date().toISOString(),
      balance: this.balanceCache,
      alertThresholdChars: ALERT_THRESHOLD_CHARS,
      configured: !!process.env.ELEVENLABS_API_KEY,
    };
  }
}
