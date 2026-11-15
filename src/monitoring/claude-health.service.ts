import { throwIfAborted } from '../common/abort';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { ClaudeCliCallError, ClaudeCliService } from '../common/services/claude-cli.service';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { isAnswerProvider } from '../common/services/llm-fallback';
import type { AnswerProvider, FallbackProvider } from '../common/services/llm-fallback';
import { CliSwitchState, cliOutageAffectedText, cliRecoveredText, switchCarriesCliPath } from '../common/global-llm-messages';
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Классификатор ошибок LLM — в common/llm-error.ts: его зовёт и ClaudeCliService
// (запасной путь).
import {
  classifyLlmError,
  LlmOutageKind,
  looksLikeCliRefusal,
  refusalDetail,
  safeCliText,
  safeKindPhrase,
} from '../common/llm-error';
// Строка про запасных — общая с алертом релея (relay-qwen-monitor.service.ts).
import { fallbackAlertLine } from './fallback-alert-line';

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
 * 30-day spend is reported, not alerted on: the Telegram alert was dropped
 * 02.09.2026 (owner's call) — it repeated what the monitoring panel already
 * shows and asked for no action. Liveness outages still alert.
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
// Повторное напоминание о продолжающемся простое (после первого алерта — не
// чаще раза в этот интервал).
const OUTAGE_REALERT_HOURS = Number(process.env.CLAUDE_OUTAGE_REALERT_H || 3);
// Сколько ПОДРЯД провалов пробы до алерта. ≥2 (≈30 мин при тике 15 мин) гасит
// транзиентные сбои (OAuth refresh, rate) и не даёт рестарту api слать ложный
// мгновенный алерт — после рестарта счётчик с нуля, нужно 2 подряд провала.
const OUTAGE_ALERT_AFTER_FAILS = Number(process.env.CLAUDE_OUTAGE_FAILS || 2);
// NOTE: Telegram creds are read at call time inside maybeAlertOutage(), not here —
// module-level process.env reads run before ConfigModule loads .env, so a
// const here would always be '' and silently disable alerts.

/**
 * Причина сбоя пробы — для админки (llmError) и алерта «Причина: …» — без
 * сырого текста CLI (spec 2026-11-02-safe-cli-errors): фиксированная фраза
 * вида; у other — с безопасным текстом ошибки (вид, код ответа, код выхода,
 * диагностика CLI) одной строкой до 160 знаков. classifyLlmError(...).human
 * для other — сырой текст, отсюда его больше не берём.
 */
function outageReason(kind: LlmOutageKind, safeText: string): string {
  const phrase = safeKindPhrase(kind);
  if (kind !== 'other') return phrase;
  const detail = String(safeText ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
  return detail ? `${phrase}: ${detail}` : phrase;
}

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
    // Общий рубильник модели (ревью 01.11): алерт о падении CLI называет, кого
    // оно задевает на самом деле. Без @Optional(): CommonModule глобальный,
    // поломка DI должна уронить старт (поймает smoke), а не молча вернуть
    // прежний текст. Сторож — claude-health.outage-alert.spec.ts.
    private readonly globalProvider: GlobalLlmProviderService,
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

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    await this.refresh();
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
        // Проба меряет сам Claude: с запасным путём она была бы «зелёной», пока
        // Claude лежит, и никто не узнал бы, что пора перелогиниться.
        noFallback: true,
      });
      const ok = typeof text === 'string' && text.trim().length > 0;
      this.cache.llmLatencyMs = Date.now() - t0;
      this.cache.llmCheckedAt = new Date().toISOString();
      if (ok && looksLikeCliRefusal(text)) {
        // Отказ CLI обычным ответом («You've hit your session limit · …») —
        // не «Claude жив»: иначе при ключе люди молча сидят на Qwen, проба
        // зелёная, алерта нет. Разбор — как у ошибки в catch: вид по тексту
        // отказа, причина — фраза вида, у other — с безопасным текстом отказа
        // (фраза CLI и хвост из белого списка, refusalDetail), как у
        // ClaudeCliService.
        const kind = classifyLlmError(text).kind;
        const human = outageReason(kind, safeCliText({ what: 'отказ', kind, detail: refusalDetail(text) }));
        down = true;
        this.cache.llmStatus = 'down';
        this.cache.llmOutageKind = kind;
        this.cache.llmError = human;
        this.log.error(`Claude CLI liveness probe DOWN (${kind}): ${human}`);
      } else if (ok) {
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
      // Вид — признак ошибки CLI (классифицирована по сырому тексту внутри
      // ClaudeCliService); по тексту — только у ошибок без признака. Текст
      // ошибки CLI безопасен — он идёт в причину только у other.
      const message = String(e?.message || e);
      const kind: LlmOutageKind = e instanceof ClaudeCliCallError && e.kind ? e.kind : classifyLlmError(message).kind;
      const human = outageReason(kind, message);
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
         FROM events WHERE name = 'claude_cli_call' AND coalesce(props->>'provider', 'claude') = 'claude'`,
      );
      const r = sums.rows[0] as any;
      const models = await this.pg.query(
        `SELECT
           COALESCE(props->>'model', 'unknown') AS model,
           COUNT(*)::int AS calls,
           COALESCE(SUM((props->>'cost_usd')::numeric), 0)::float AS cost_usd
         FROM events
         WHERE name = 'claude_cli_call' AND ts >= now() - interval '30 days'
           AND coalesce(props->>'provider', 'claude') = 'claude'
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

  // Алерт «Claude: высокий расход за 30 дней» убран по решению владельца
  // 02.09.2026. Расход за 30 дней — вещь ожидаемая и медленная: при пороге $300
  // и подписке max он раз в сутки повторял то, что и так видно в админке, и
  // ничего не требовал сделать прямо сейчас. Сама цифра никуда не делась:
  // cost30dUsd считается в refresh() и отдаётся в overview, а панель мониторинга
  // красит её по ALERT_THRESHOLD_30D_USD. Пропала только рассылка в Telegram.

  /** Отдельный instance без PG: markUp и события пробы не меняют рабочий breaker/статистику. */
  private newSwitchProbeCli(): ClaudeCliService {
    return new ClaudeCliService();
  }

  /** Свежая проверка выбранного рубильником провайдера; сырой текст CLI не логируем. */
  private async probeSwitchProvider(provider: FallbackProvider): Promise<boolean> {
    try {
      const text = await this.newSwitchProbeCli().text('Reply with exactly: ok', {
        provider,
        providerChoice: 'global',
        noFallback: true,
        model: 'claude-haiku-4-5',
        timeoutMs: 30_000,
        isolatedCwd: true,
        noSessionPersistence: true,
      });
      if (typeof text === 'string' && text.trim().length > 0 && !looksLikeCliRefusal(text)) return true;
      const kind = classifyLlmError(typeof text === 'string' ? text : '').kind;
      this.log.warn(`${provider} liveness probe DOWN (${kind})`);
      return false;
    } catch (e: any) {
      const message = String(e?.message || e);
      const kind = e instanceof ClaudeCliCallError && e.kind ? e.kind : classifyLlmError(message).kind;
      this.log.warn(`${provider} liveness probe DOWN (${kind})`);
      return false;
    }
  }

  /** Единый statement snapshot: provider и личный Claude согласованы; ошибка — fail-open. */
  private async readFinalProviderAndPersonal(): Promise<{ provider: AnswerProvider; personalClaude: boolean } | null> {
    try {
      const r = await this.pg.query(
        `SELECT
           (SELECT value->>'provider' FROM llm_settings WHERE key = 'global_provider') AS global_provider,
           EXISTS (
             SELECT 1
             FROM ai_profiles_consolidated p
             JOIN user_id u ON u.internal_id = p.user_id
             WHERE p.llm_provider = 'claude'
               AND u.state = 'active'
           ) AS personal_claude`,
      );
      const value = r.rows[0]?.global_provider;
      return {
        provider: isAnswerProvider(value) ? value : 'claude',
        personalClaude: r.rows[0]?.personal_claude === true,
      };
    } catch (e: any) {
      this.log.warn(`llm_settings: строгий snapshot для CLI-алерта не прочитан: ${e?.message || 'unknown'}`);
      return null;
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
    const recoveryDue = status === 'ok' && alreadyAlerted;
    if (status !== 'down' && !recoveryDue) return;
    const belowThreshold = status === 'down' && this.cliConsecutiveDown < OUTAGE_ALERT_AFTER_FAILS;
    if (belowThreshold && !alreadyAlerted) return;

    const stats = this.claudeCli.fallbackStats(now.getTime());
    const sw = await this.switchState(stats, now.getTime());
    let effectiveStats = stats;
    let effectiveSw: CliSwitchState = sw;
    let globalAlive = false;
    if (sw.switchProvider !== 'claude' && switchCarriesCliPath(sw)) {
      const probedProvider = sw.switchProvider;
      const probeOk = await this.probeSwitchProvider(probedProvider);
      const final = probeOk ? await this.readFinalProviderAndPersonal() : null;
      const afterNow = Date.now();
      const afterStats = this.claudeCli.fallbackStats(afterNow);
      const afterSw = final
        ? this.switchStateFromStats(final.provider, afterStats, afterNow)
        : await this.switchState(afterStats, afterNow);
      const personalClaude = final ? final.personalClaude : true;
      effectiveStats = afterStats;
      effectiveSw = afterSw;
      const sameProvider = afterSw.switchProvider === probedProvider;
      globalAlive = probeOk && final !== null && sameProvider && switchCarriesCliPath(afterSw) && !personalClaude;
      if (!sameProvider && switchCarriesCliPath(afterSw)) {
        effectiveSw = { ...afterSw, providerUnverified: true };
      } else if (sameProvider && afterSw.enabled && !afterSw.down && !probeOk) {
        effectiveSw = { ...afterSw, probeFailed: true };
      }
    }
    if (globalAlive) {
      // Последний await был до этого решения: suppression не использует устаревший рубильник.
      if (alreadyAlerted) {
        this.lastOutageAlertAt = null;
        await this.setAlerted(COMPONENT, false);
        this.log.warn(`Claude CLI alert cleared without Telegram: ${sw.switchProvider} answered probe`);
      }
      return;
    }
    if (belowThreshold) return;

    if (status === 'down') {
      const cooled = !this.lastOutageAlertAt ||
        (now.getTime() - this.lastOutageAlertAt.getTime()) >= OUTAGE_REALERT_HOURS * 3600_000;
      if (!alreadyAlerted || cooled) {
        await send(
          `<b>🔴 Локальный Claude CLI недоступен</b>\n` +
          `Причина: <b>${this.cache.llmError || 'неизвестно'}</b> (${this.cache.llmOutageKind})\n` +
          `${cliOutageAffectedText(effectiveSw)} ` +
          `Чат-ассистенты (r.linkeon.io) — отдельный путь, см. synthetic chat_streaming.\n` +
          `Провалов подряд: ${this.cliConsecutiveDown}. Проверка: ${this.cache.llmCheckedAt || '—'}\n` +
          `${fallbackAlertLine(effectiveStats)}\n` +
          `Починка: на проде \`claude\` → /login (обновить OAuth).`,
        );
        this.lastOutageAlertAt = now;
        await this.setAlerted(COMPONENT, true);
        this.log.error(`Claude CLI outage alert sent (${this.cache.llmOutageKind}, ${this.cliConsecutiveDown} fails)`);
      }
    } else {
      await send(cliRecoveredText({ ...effectiveSw, checkedAt: this.cache.llmCheckedAt, latencyMs: this.cache.llmLatencyMs }));
      this.lastOutageAlertAt = null;
      await this.setAlerted(COMPONENT, false);
      this.log.warn('Claude CLI recovery alert sent');
    }
  }

  /**
   * Модель общего рубильника и её состояние — для алерта о падении и отбоя
   * (ревью 01.11). enabled — ключ есть (providers[x].enabled: тот же
   * признак, что configs[x] !== null); down — она «не отвечает», и выбор
   * рубильника её пропускает (planProviders с respectDown). get() не бросает
   * (контракт GlobalLlmProviderService.get).
   */
  private switchStateFromStats(
    switchProvider: AnswerProvider,
    stats: ReturnType<ClaudeCliService['fallbackStats']>,
    now: number,
  ): CliSwitchState {
    const st = switchProvider === 'claude' ? undefined : stats.providers?.[switchProvider];
    return { switchProvider, enabled: !!st?.enabled, down: !!st && st.downUntil > now };
  }

  private async switchState(stats: ReturnType<ClaudeCliService['fallbackStats']>, now: number): Promise<CliSwitchState> {
    return this.switchStateFromStats(await this.globalProvider.get(), stats, now);
  }

  async getOverview(signal?: AbortSignal): Promise<ClaudeHealthOverview> {
    throwIfAborted(signal);
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
