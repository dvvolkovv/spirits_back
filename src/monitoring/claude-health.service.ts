import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Классификация ошибки LLM-пробы → тип сбоя + человекочитаемая причина.
// Вынесено наружу и чисто (без side-effects) для юнит-теста. Главный кейс,
// который раньше был невидим мониторингу: «недельный лимит» Claude-подписки —
// весь AI платформы (ассистенты через r.linkeon.io + Юля + Маша + VPM/VMM) сидит
// на ней, поэтому её исчерпание = полная деградация продукта.
export type LlmOutageKind = 'weekly_limit' | 'rate_limit' | 'auth' | 'overloaded' | 'timeout' | 'other';
export function classifyLlmError(msg: string): { kind: LlmOutageKind; human: string } {
  const m = String(msg || '').toLowerCase();
  if (/weekly limit|hit your .*limit|usage limit|limit .*reset|limit reached|исчерпан.*лимит|недельн/.test(m))
    return { kind: 'weekly_limit', human: 'Исчерпан лимит Claude-подписки (недельный/использования)' };
  if (/rate limit|too many requests|\b429\b/.test(m))
    return { kind: 'rate_limit', human: 'Rate limit Claude (слишком много запросов)' };
  if (/unauthorized|\b401\b|invalid api key|authentication|oauth|credential|not logged in|please run .*login/.test(m))
    return { kind: 'auth', human: 'Сбой авторизации Claude (OAuth/API-ключ)' };
  if (/overloaded|\b529\b|\b503\b|internal server|try again|temporarily/.test(m))
    return { kind: 'overloaded', human: 'Claude перегружен/временно недоступен' };
  if (/timeout|timed out|deadline/.test(m))
    return { kind: 'timeout', human: 'Таймаут вызова Claude' };
  return { kind: 'other', human: msg ? String(msg).slice(0, 160) : 'Неизвестная ошибка LLM' };
}

/**
 * Claude health/usage monitoring.
 *
 * Unlike SMS Aero / OpenRouter / ElevenLabs, Claude has no $-balance to
 * report. We use it two ways:
 *  1. via `claude` CLI authenticated against a Claude Max subscription
 *     (OAuth) — a flat-rate plan with rate limits but no balance
 *  2. via Anthropic API with a pay-as-you-go key — billing on file
 *
 * So "balance" here is reframed as:
 *  - subscription status (max / pro / free, expires_at)
 *  - rolling spend over 24h / 30d, aggregated from `events` rows
 *    inserted by ClaudeCliService on every CLI call
 *  - API key validity (cheap probe to /v1/models)
 *  - daily call count
 *
 * If we ever burn more than a configurable monthly $ threshold,
 * Telegram alert fires (cooldown 24h).
 */

interface UsageSnapshot {
  // Rolling sums from events table
  cost24hUsd: number | null;
  cost30dUsd: number | null;
  calls24h: number | null;
  calls30d: number | null;
  topModels30d: Array<{ model: string; calls: number; cost_usd: number }>;
  // Subscription (claude CLI OAuth credentials)
  subscriptionType: string | null;       // 'max' | 'pro' | 'free' | null
  subscriptionExpiresAt: string | null;  // ISO or null
  // Anthropic API key health (separate from CLI subscription)
  apiKeyValid: boolean | null;
  apiKeyError: string | null;
  // Liveness: реально ли AI отвечает прямо сейчас (активная проба LLM-пути).
  // Это и есть то, чего не хватало: расход/ключ могут быть «ок», а AI лежать
  // из-за недельного лимита подписки.
  llmStatus: 'ok' | 'down' | null;
  llmOutageKind: LlmOutageKind | null;
  llmError: string | null;
  llmCheckedAt: string | null;
  llmLatencyMs: number | null;
  fetchedAt: string;
}

const ALERT_THRESHOLD_30D_USD = Number(process.env.CLAUDE_SPEND_ALERT_THRESHOLD_30D_USD || 300);
const ALERT_COOLDOWN_HOURS = Number(process.env.CLAUDE_SPEND_ALERT_COOLDOWN_H || 24);
// Повторное напоминание о продолжающемся простое (после первого алерта — не
// чаще раза в этот интервал).
const OUTAGE_REALERT_HOURS = Number(process.env.CLAUDE_OUTAGE_REALERT_H || 3);
// Сколько ПОДРЯД провалов пробы до алерта. ≥2 (≈30 мин при тике 15 мин) гасит
// транзиентные сбои (OAuth refresh, rate) и не даёт рестарту api слать ложный
// мгновенный алерт — после рестарта счётчик с нуля, нужно 2 подряд провала.
const OUTAGE_ALERT_AFTER_FAILS = Number(process.env.CLAUDE_OUTAGE_FAILS || 2);
// NOTE: Telegram creds are read at call time inside maybeAlert(), not here —
// module-level process.env reads run before ConfigModule loads .env, so a
// const here would always be '' and silently disable alerts.

export interface ClaudeHealthOverview {
  generatedAt: string;
  usage: UsageSnapshot;
  alertThreshold30dUsd: number;
  configured: {
    apiKey: boolean;
    cliCredentials: boolean;
  };
}

@Injectable()
export class ClaudeHealthService implements OnModuleInit {
  private readonly log = new Logger(ClaudeHealthService.name);
  private cache: UsageSnapshot = {
    cost24hUsd: null, cost30dUsd: null,
    calls24h: null, calls30d: null,
    topModels30d: [],
    subscriptionType: null,
    subscriptionExpiresAt: null,
    apiKeyValid: null, apiKeyError: null,
    llmStatus: null, llmOutageKind: null, llmError: null, llmCheckedAt: null, llmLatencyMs: null,
    fetchedAt: new Date(0).toISOString(),
  };
  // Liveness alert state. consecutiveDown — подряд-провалы CLI-пробы (сброс к 0
  // при ok и при рестарте). Факт «уже заалертили про этот простой» персистится в
  // monitor_alert_state, чтобы рестарт во время длящегося простоя не дублировал.
  private cliConsecutiveDown = 0;
  private lastOutageAlertAt: Date | null = null;

  constructor(
    private readonly pg: PgService,
    private readonly claudeCli: ClaudeCliService,
  ) {}

  async onModuleInit() {
    this.refresh().catch(() => {});
    // Персист состояния алерта — переживает рестарты (иначе каждый рестарт во
    // время простоя слал бы «новый» алерт; инцидент 2026-06-10).
    try {
      await this.pg.query(
        `CREATE TABLE IF NOT EXISTS monitor_alert_state (
           component   text PRIMARY KEY,
           alerted     boolean NOT NULL DEFAULT false,
           updated_at  timestamptz NOT NULL DEFAULT now()
         )`,
      );
    } catch (e: any) {
      this.log.error(`monitor_alert_state migration failed: ${e.message}`);
    }
    // Не пробим прямо на старте (пусть приложение поднимется); первый
    // liveness-тик придёт по крону.
  }

  private async getAlerted(component: string): Promise<boolean> {
    try {
      const r = await this.pg.query(`SELECT alerted FROM monitor_alert_state WHERE component=$1`, [component]);
      return r.rows[0]?.alerted === true;
    } catch { return false; }
  }
  private async setAlerted(component: string, alerted: boolean): Promise<void> {
    try {
      await this.pg.query(
        `INSERT INTO monitor_alert_state (component, alerted, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (component) DO UPDATE SET alerted=$2, updated_at=now()`,
        [component, alerted],
      );
    } catch (e: any) { this.log.error(`setAlerted(${component}) failed: ${e.message}`); }
  }
  // Состояние + время последнего перехода (для persisted-кулдауна, переживает рестарт PM2).
  private async getAlertState(component: string): Promise<{ alerted: boolean; updatedAt: Date | null }> {
    try {
      const r = await this.pg.query(`SELECT alerted, updated_at FROM monitor_alert_state WHERE component=$1`, [component]);
      if (!r.rows[0]) return { alerted: false, updatedAt: null };
      return { alerted: r.rows[0].alerted === true, updatedAt: r.rows[0].updated_at ? new Date(r.rows[0].updated_at) : null };
    } catch { return { alerted: false, updatedAt: null }; }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    await this.refresh();
    await this.maybeAlert();
  }

  // Активная проба «жив ли AI» каждые 15 минут + алерт на отказ/восстановление.
  // Отдельно от hourly: простой AI — P1, его надо ловить быстро, а не раз в час.
  @Cron('0 */15 * * * *')
  async livenessTick() {
    await this.probeLiveness();
    await this.maybeAlertOutage();
  }

  // Проба ЛОКАЛЬНОГО claude CLI — путь, по которому работают Маша, Виртуальный PM
  // и Виртуальный маркетолог (и tasks-извлечение). НЕ путь чат-ассистентов: они
  // идут через r.linkeon.io, который мониторится отдельно synthetic-сценарием
  // chat_streaming. Поэтому алерт здесь — про CLI-путь, а не про «весь AI»
  // (инцидент 2026-06-10: проба ложно сообщала о недоступности всех ассистентов).
  private async probeLiveness(): Promise<void> {
    const t0 = Date.now();
    let down = false;
    try {
      const text = await this.claudeCli.text('Reply with exactly: ok', {
        model: 'claude-haiku-4-5',
        timeoutMs: 30_000,
      });
      const ok = typeof text === 'string' && text.trim().length > 0;
      this.cache.llmLatencyMs = Date.now() - t0;
      this.cache.llmCheckedAt = new Date().toISOString();
      if (ok) {
        this.cache.llmStatus = 'ok';
        this.cache.llmOutageKind = null;
        this.cache.llmError = null;
      } else {
        down = true;
        this.cache.llmStatus = 'down';
        this.cache.llmOutageKind = 'other';
        this.cache.llmError = 'пустой ответ CLI';
      }
    } catch (e: any) {
      const { kind, human } = classifyLlmError(e?.message || String(e));
      down = true;
      this.cache.llmStatus = 'down';
      this.cache.llmOutageKind = kind;
      this.cache.llmError = human;
      this.cache.llmLatencyMs = Date.now() - t0;
      this.cache.llmCheckedAt = new Date().toISOString();
      this.log.error(`Claude CLI liveness probe DOWN (${kind}): ${human}`);
    }
    this.cliConsecutiveDown = down ? this.cliConsecutiveDown + 1 : 0;
  }

  private async refresh(): Promise<void> {
    const [usage, subscription, apiKey] = await Promise.all([
      this.aggregateUsage(),
      this.readSubscription(),
      this.probeApiKey(),
    ]);
    this.cache = {
      ...usage,
      ...subscription,
      ...apiKey,
      // liveness обновляется отдельным крон-тиком (probeLiveness) — сохраняем,
      // иначе hourly refresh затёр бы его undefined'ами.
      llmStatus: this.cache.llmStatus,
      llmOutageKind: this.cache.llmOutageKind,
      llmError: this.cache.llmError,
      llmCheckedAt: this.cache.llmCheckedAt,
      llmLatencyMs: this.cache.llmLatencyMs,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async aggregateUsage() {
    try {
      const sums = await this.pg.query(
        `SELECT
           COALESCE(SUM((props->>'cost_usd')::numeric) FILTER (WHERE ts >= now() - interval '24 hours'), 0) AS cost_24h,
           COALESCE(SUM((props->>'cost_usd')::numeric) FILTER (WHERE ts >= now() - interval '30 days'),  0) AS cost_30d,
           COUNT(*) FILTER (WHERE ts >= now() - interval '24 hours')::int AS calls_24h,
           COUNT(*) FILTER (WHERE ts >= now() - interval '30 days')::int  AS calls_30d
         FROM events WHERE name = 'claude_cli_call'`,
      );
      const r = sums.rows[0] as any;
      const models = await this.pg.query(
        `SELECT
           COALESCE(props->>'model', 'unknown') AS model,
           COUNT(*)::int AS calls,
           COALESCE(SUM((props->>'cost_usd')::numeric), 0)::float AS cost_usd
         FROM events
         WHERE name = 'claude_cli_call' AND ts >= now() - interval '30 days'
         GROUP BY 1 ORDER BY cost_usd DESC LIMIT 5`,
      );
      return {
        cost24hUsd: Number(r?.cost_24h) || 0,
        cost30dUsd: Number(r?.cost_30d) || 0,
        calls24h: Number(r?.calls_24h) || 0,
        calls30d: Number(r?.calls_30d) || 0,
        topModels30d: models.rows.map((m: any) => ({
          model: String(m.model),
          calls: Number(m.calls),
          cost_usd: Number(m.cost_usd),
        })),
      };
    } catch (e: any) {
      this.log.warn(`Claude usage aggregation failed: ${e.message}`);
      return {
        cost24hUsd: null, cost30dUsd: null,
        calls24h: null, calls30d: null,
        topModels30d: [],
      };
    }
  }

  // Claude CLI stores OAuth credentials at ~/.claude/.credentials.json with
  // a `claudeAiOauth` object containing subscriptionType + expires_at.
  // Reading the file is cheap and lives on the same filesystem as our
  // pm2 process — no extra moving parts.
  private async readSubscription() {
    try {
      const home = process.env.HOME || os.homedir();
      const credPath = process.env.CLAUDE_CREDENTIALS_PATH || path.join(home, '.claude', '.credentials.json');
      if (!fs.existsSync(credPath)) {
        return { subscriptionType: null, subscriptionExpiresAt: null };
      }
      const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      const oauth = raw?.claudeAiOauth || {};
      const subType: string | null = oauth?.subscriptionType ?? null;
      const expiresAtNum = oauth?.expires_at;
      let subExpires: string | null = null;
      if (typeof expiresAtNum === 'number' && expiresAtNum > 0) {
        // Unix seconds OR ms — pick by magnitude
        const ms = expiresAtNum > 1e12 ? expiresAtNum : expiresAtNum * 1000;
        subExpires = new Date(ms).toISOString();
      }
      return { subscriptionType: subType, subscriptionExpiresAt: subExpires };
    } catch (e: any) {
      this.log.warn(`Reading claude credentials failed: ${e.message}`);
      return { subscriptionType: null, subscriptionExpiresAt: null };
    }
  }

  // Cheap key-validity probe. /v1/models requires only a valid x-api-key
  // and no spend; success means the key is live and not revoked. Doesn't
  // expose balance — Anthropic doesn't have a public balance endpoint
  // even for non-admin keys.
  // NB: после миграции на OAuth-подписку (Дмитрий, 2026-06-07) ANTHROPIC_API_KEY
  // штатно ОТСУТСТВУЕТ в .env — весь AI идёт через OAuth (claude CLI / Agent SDK).
  // Поэтому отсутствие ключа — это норма (OAuth-режим), а не сбой: возвращаем
  // apiKeyValid=null без ошибки, чтобы мониторинг не показывал ложную проблему.
  // Реальный сигнал здоровья AI — liveness-проба (probeLiveness, OAuth).
  private async probeApiKey(): Promise<{ apiKeyValid: boolean | null; apiKeyError: string | null }> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { apiKeyValid: null, apiKeyError: null };
    try {
      const r = await axios.get('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        timeout: 8000,
        validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300) {
        return { apiKeyValid: true, apiKeyError: null };
      }
      return {
        apiKeyValid: false,
        apiKeyError: `anthropic ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`,
      };
    } catch (e: any) {
      return { apiKeyValid: null, apiKeyError: e?.message || 'network' };
    }
  }

  private async maybeAlert(): Promise<void> {
    const c30 = this.cache.cost30dUsd;
    if (c30 === null) return;
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
    if (!TG_TOKEN || !TG_CHAT) return;
    const COMP = 'claude_spend';

    // Ниже порога — сбросить флаг, чтобы при следующем превышении снова алертнуть.
    if (c30 < ALERT_THRESHOLD_30D_USD) {
      if (await this.getAlerted(COMP)) await this.setAlerted(COMP, false);
      return;
    }

    // Превышение: алертим не чаще раза в ALERT_COOLDOWN_HOURS. Состояние persisted
    // в monitor_alert_state (updated_at), поэтому рестарт PM2 НЕ сбрасывает кулдаун
    // и не приводит к спаму (это был баг in-memory lastAlertAt).
    const st = await this.getAlertState(COMP);
    if (st.alerted && st.updatedAt && (Date.now() - st.updatedAt.getTime()) < ALERT_COOLDOWN_HOURS * 3600_000) {
      return;
    }
    try {
      await sendTelegramPayload({
        chat_id: TG_CHAT,
        parse_mode: 'HTML',
        text: `<b>⚠️ Claude: высокий расход за 30 дней</b>\n` +
              `Сейчас: <b>$${c30.toFixed(2)}</b>\n` +
              `Порог: $${ALERT_THRESHOLD_30D_USD}\n` +
              `Подписка: ${this.cache.subscriptionType || 'не определена'}\n` +
              `Биллинг: https://console.anthropic.com/settings/billing`,
      }, { timeout: 8000 });
      await this.setAlerted(COMP, true); // пишет updated_at=now → старт кулдауна
      this.log.warn(`Claude spend over threshold: $${c30} — Telegram alert sent`);
    } catch (e: any) {
      this.log.error(`Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }

  // Алерт о простое CLI-пути (Маша / Виртуальный PM / маркетолог). Точный охват:
  // НЕ «весь AI» — чат-ассистенты (r.linkeon.io) мониторятся отдельно synthetic
  // chat_streaming. Алерт только после OUTAGE_ALERT_AFTER_FAILS подряд провалов
  // (гасит транзиент и рестарт-спам); повтор не чаще OUTAGE_REALERT_HOURS; факт
  // алерта персистится (рестарт во время простоя не дублирует); при ok — отбой.
  private async maybeAlertOutage(): Promise<void> {
    const status = this.cache.llmStatus;
    if (status === null) return;
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
    const now = new Date();
    const COMPONENT = 'claude_cli';

    const send = async (text: string) => {
      if (!TG_TOKEN || !TG_CHAT) { this.log.warn(`CLI outage alert (no Telegram creds): ${text.replace(/<[^>]+>/g, '')}`); return; }
      try {
        await sendTelegramPayload({ chat_id: TG_CHAT, parse_mode: 'HTML', text }, { timeout: 8000 });
      } catch (e: any) {
        this.log.error(`CLI outage Telegram alert failed: ${e?.message || 'unknown'}`);
      }
    };

    const alreadyAlerted = await this.getAlerted(COMPONENT);

    if (status === 'down') {
      // Алертим только при устойчивом простое (≥K подряд) и если ещё не алертили
      // (или прошёл realert-интервал).
      if (this.cliConsecutiveDown < OUTAGE_ALERT_AFTER_FAILS) return;
      const cooled = !this.lastOutageAlertAt ||
        (now.getTime() - this.lastOutageAlertAt.getTime()) >= OUTAGE_REALERT_HOURS * 3600_000;
      if (!alreadyAlerted || cooled) {
        await send(
          `<b>🔴 Локальный Claude CLI недоступен</b>\n` +
          `Причина: <b>${this.cache.llmError || 'неизвестно'}</b> (${this.cache.llmOutageKind})\n` +
          `Затронуто: <b>Маша, Виртуальный PM, Виртуальный маркетолог</b> (CLI-путь на OAuth-подписке). ` +
          `Чат-ассистенты (r.linkeon.io) — отдельный путь, см. synthetic chat_streaming.\n` +
          `Провалов подряд: ${this.cliConsecutiveDown}. Проверка: ${this.cache.llmCheckedAt || '—'}\n` +
          `Починка: на проде \`claude\` → /login (обновить OAuth).`,
        );
        this.lastOutageAlertAt = now;
        await this.setAlerted(COMPONENT, true);
        this.log.error(`Claude CLI outage alert sent (${this.cache.llmOutageKind}, ${this.cliConsecutiveDown} fails)`);
      }
    } else if (status === 'ok' && alreadyAlerted) {
      await send(`<b>🟢 Локальный Claude CLI восстановлен</b>\nМаша/VPM/маркетолог снова работают (проверка: ${this.cache.llmCheckedAt || '—'}, ${this.cache.llmLatencyMs ?? '—'}мс).`);
      this.lastOutageAlertAt = null;
      await this.setAlerted(COMPONENT, false);
      this.log.warn('Claude CLI recovery alert sent');
    }
  }

  async getOverview(): Promise<ClaudeHealthOverview> {
    return {
      generatedAt: new Date().toISOString(),
      usage: this.cache,
      alertThreshold30dUsd: ALERT_THRESHOLD_30D_USD,
      configured: {
        apiKey: !!process.env.ANTHROPIC_API_KEY,
        cliCredentials: this.cache.subscriptionType !== null,
      },
    };
  }
}
