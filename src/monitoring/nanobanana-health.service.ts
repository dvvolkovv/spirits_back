import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';

/**
 * Nano Banana (Gemini 3.x image models) health monitoring.
 *
 * Nano Banana is the FALLBACK image generator behind generate_image / edit_image /
 * compose_image (see misc.generateImage: Imagen 4.0 Ultra primary → Nano Banana
 * fallback, both on GOOGLE_AI_API_KEY). It broke silently once and nobody noticed
 * (backlog 6992a2a7) — so this actively probes it and alerts to Telegram on breakage.
 *
 * Probe = the FREE Gemini GetModel metadata call for the exact model the app uses.
 * A passive success/failure event count can't tell "integration down" from "nobody
 * asked for an image lately", and a real generateContent probe costs money every run;
 * GetModel needs no generation yet still catches the realistic silent-break causes:
 *   - invalid/revoked GOOGLE_AI_API_KEY → 400/403
 *   - model renamed / deprecated / pulled → 404  (the classic "it just stopped")
 *   - endpoint / network outage → timeout
 * It does NOT verify a generation actually renders pixels; if that stronger guarantee
 * is ever needed, swap the GET for the misc.generateImage generateContent body.
 *
 * Telegram creds reused from the shared monitoring channel (TELEGRAM_BOT_TOKEN +
 * TELEGRAM_CHAT_ID, no new env). GOOGLE_AI_API_KEY absent → configured:false: no
 * probe, no alert, doesn't drag overall health down. First failure of an outage
 * alerts immediately; while it stays down it re-pings at most once per cooldown; a
 * single "recovered" note fires when a prior outage clears.
 */

const PROBE_MODEL = process.env.NANOBANANA_PROBE_MODEL || 'gemini-3.1-flash-image-preview';
const ALERT_COOLDOWN_HOURS = Number(process.env.NANOBANANA_ALERT_COOLDOWN_H || 12);

export interface NanoBananaHealthOverview {
  generatedAt: string;
  configured: boolean;
  model: string;
  healthy: boolean | null; // null = configured but not probed yet
  latencyMs: number | null;
  checkedAt: string | null;
  error: string | null;
  consecutiveFailures: number;
}

@Injectable()
export class NanoBananaHealthService implements OnModuleInit {
  private readonly log = new Logger(NanoBananaHealthService.name);
  private healthy: boolean | null = null;
  private latencyMs: number | null = null;
  private checkedAt: string | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;
  private lastAlertAt: Date | null = null;

  async onModuleInit() {
    // Probe shortly after boot (don't block app startup); cron handles the rest.
    setTimeout(() => this.probe().catch(() => {}), 30_000);
  }

  // Every hour at :47 (offset from the other health crons to spread load).
  @Cron('0 47 * * * *')
  async scheduled() {
    await this.probe();
  }

  private configured(): boolean {
    return !!process.env.GOOGLE_AI_API_KEY;
  }

  private async probe(): Promise<void> {
    if (!this.configured()) {
      this.healthy = null;
      this.lastError = 'GOOGLE_AI_API_KEY not set';
      return;
    }
    const apiKey = process.env.GOOGLE_AI_API_KEY as string;
    const started = Date.now();
    try {
      const resp = await axios.get(
        `https://generativelanguage.googleapis.com/v1beta/models/${PROBE_MODEL}?key=${apiKey}`,
        { timeout: 15_000, validateStatus: () => true },
      );
      this.latencyMs = Date.now() - started;
      this.checkedAt = new Date().toISOString();
      if (resp.status === 200 && resp.data?.name) {
        await this.markSuccess();
        return;
      }
      const hint =
        resp.status === 404 ? ' (модель переименована/снята?)'
          : resp.status === 400 || resp.status === 403 ? ' (проблема с GOOGLE_AI_API_KEY?)'
            : '';
      await this.markFailure(`HTTP ${resp.status}${hint}: ${JSON.stringify(resp.data).slice(0, 300)}`);
    } catch (e: any) {
      this.latencyMs = Date.now() - started;
      this.checkedAt = new Date().toISOString();
      await this.markFailure(e?.message || 'network error');
    }
  }

  private async markSuccess(): Promise<void> {
    const wasDown = this.healthy === false;
    const failedFor = this.consecutiveFailures;
    this.healthy = true;
    this.lastError = null;
    this.consecutiveFailures = 0;
    if (wasDown) {
      this.log.log(`Nano Banana recovered after ${failedFor} failed probe(s)`);
      await this.sendAlert(
        `<b>✅ Nano Banana восстановился</b>\n` +
          `Модель: <code>${PROBE_MODEL}</code>\n` +
          `Был недоступен ${failedFor} проб(ы) подряд — снова доступен.`,
        true, // recovery bypasses cooldown
      );
      this.lastAlertAt = null; // let the next outage alert immediately
    }
  }

  private async markFailure(error: string): Promise<void> {
    this.healthy = false;
    this.lastError = error;
    this.consecutiveFailures += 1;
    this.log.error(`Nano Banana probe failed (#${this.consecutiveFailures}): ${error}`);
    const firstFailure = this.consecutiveFailures === 1; // fresh outage → alert now
    await this.sendAlert(
      `<b>⚠️ Nano Banana не отвечает</b>\n` +
        `Модель: <code>${PROBE_MODEL}</code>\n` +
        `Проб подряд с ошибкой: <b>${this.consecutiveFailures}</b>\n` +
        `Ошибка: <code>${this.escape(error.slice(0, 400))}</code>\n` +
        `Это фолбэк-генератор картинок (generate_image). Проверить GOOGLE_AI_API_KEY / имя модели / квоту Google.`,
      firstFailure,
    );
  }

  private async sendAlert(text: string, bypassCooldown = false): Promise<void> {
    if (!process.env.TELEGRAM_BOT_TOKEN || !(process.env.TELEGRAM_CHAT_ID || '')) return;
    const now = new Date();
    if (
      !bypassCooldown &&
      this.lastAlertAt &&
      now.getTime() - this.lastAlertAt.getTime() < ALERT_COOLDOWN_HOURS * 3600_000
    ) {
      return;
    }
    try {
      await sendTelegramPayload({ parse_mode: 'HTML', text });
      this.lastAlertAt = now;
    } catch (e: any) {
      this.log.error(`Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  getOverview(): NanoBananaHealthOverview {
    return {
      generatedAt: new Date().toISOString(),
      configured: this.configured(),
      model: PROBE_MODEL,
      healthy: this.healthy,
      latencyMs: this.latencyMs,
      checkedAt: this.checkedAt,
      error: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}
