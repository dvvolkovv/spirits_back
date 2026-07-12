import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { sendTelegramAlert } from '../common/telegram-alert';
import { ChatService } from '../chat/chat.service';
import { SyntheticService } from './synthetic.service';

/**
 * Quality self-monitoring (инициатива «гарантия качества доставки», беклог
 * a867ef3b). Активный слой ПОВЕРХ пассивного JobsMonitorService: крон, который
 * проактивно ловит РЕГРЕССИИ КАЧЕСТВА, влияющие на конечного пользователя, и
 * шлёт Telegram-алерт с actionable-текстом. Старт — самое частое user-facing
 * зло: провалы платных провайдеров (Kling/Google) из-за нашего баланса/квоты
 * (инцидент 01.07 «Account balance not enough») и всплеск падений видео.
 *
 * Расширяемо: сюда же добавлять другие quality-сигналы (пустые ответы,
 * англ-утечки, всплеск рефандов) по мере появления надёжных источников.
 */

const PROVIDER_FAIL_WINDOW_MIN = Number(process.env.QUALITY_PROVIDER_WINDOW_MIN || 60);
const FAILRATE_WINDOW_MIN = Number(process.env.QUALITY_FAILRATE_WINDOW_MIN || 120);
const FAILRATE_MIN_SAMPLE = Number(process.env.QUALITY_FAILRATE_MIN_SAMPLE || 5);
const FAILRATE_ALERT_PCT = Number(process.env.QUALITY_FAILRATE_ALERT_PCT || 50);
const ALERT_COOLDOWN_H = Number(process.env.QUALITY_ALERT_COOLDOWN_H || 3);
const CHAT_WINDOW_MIN = Number(process.env.QUALITY_CHAT_WINDOW_MIN || 120);
const CHAT_MIN_SAMPLE = Number(process.env.QUALITY_CHAT_MIN_SAMPLE || 20);
const EMPTY_ALERT_PCT = Number(process.env.QUALITY_EMPTY_ALERT_PCT || 15);
const LEAK_ALERT_PCT = Number(process.env.QUALITY_LEAK_ALERT_PCT || 10);

export interface QualityOverview {
  generatedAt: string;
  providerFailures: { window_min: number; count: number; sample: string | null };
  videoFailureRate: { window_min: number; failed: number; total: number; pct: number | null };
  chat: { window_min: number; responses: number; empty: number; emptyPct: number | null; englishLeak: number; leakPct: number | null; deduped: number };
  alerts: string[];
}

@Injectable()
export class QualityMonitorService {
  private readonly log = new Logger(QualityMonitorService.name);
  private lastAlertAt: Record<string, number> = {};

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly chat?: ChatService,
    @Optional() private readonly synthetic?: SyntheticService,
  ) {}

  // ── Синтетическая quality-проба (#5): реально гоняем чат через r.linkeon.io
  // и верифицируем КАЧЕСТВО ответа (не пустой, на русском, без ошибки-плейсхолдера),
  // а не только 200 OK. Без списания токенов (generateAgentReply не списывает).
  // Одна попытка пробы: генерим ответ и валидируем качество. Возвращает issues[].
  private async probeOnce(probeUser: string, assistantId: string, prompt: string): Promise<{ issues: string[]; text: string; durationMs: number }> {
    const started = Date.now();
    let text = '';
    let hardFail: string | null = null;
    try {
      text = await this.chat!.generateAgentReply(probeUser, assistantId, prompt);
    } catch (e: any) {
      hardFail = `generate failed: ${e?.message || 'unknown'}`;
    }
    const durationMs = Date.now() - started;
    const issues: string[] = [];
    if (hardFail) issues.push(hardFail);
    else if (!text || text.trim().length < 5) issues.push('пустой/слишком короткий ответ');
    else {
      if (/ошибка запуска агента|ответ не пришёл|failed to fetch|internal server error/i.test(text)) issues.push('ответ-плейсхолдер ошибки');
      const letters = (text.match(/\p{L}/gu) || []).length;
      const cyr = (text.match(/[Ѐ-ӿ]/g) || []).length;
      if (letters >= 20 && cyr / letters < 0.3) issues.push('ответ не на русском (англ-утечка)');
    }
    return { issues, text, durationMs };
  }

  @Cron('0 7,37 * * * *') // каждые 30 мин, со смещением от других кронов
  async qualityProbe() {
    if (process.env.QUALITY_PROBE_DISABLED === 'true' || !this.chat) return;
    const probeUser = process.env.QUALITY_PROBE_USER || '70000000000';
    const assistantId = process.env.QUALITY_PROBE_ASSISTANT || '12'; // Роман
    const prompt = 'Техническая проверка. Ответь ОДНИМ коротким предложением на русском языке: пожелай хорошего дня.';

    // Ретрай-once: r.linkeon иногда отдаёт пустой поток разово (транзиент). Фейл
    // засчитываем только если ДВЕ попытки подряд плохие — это уже деградация,
    // а не блип. Успех любой попытки = ok.
    let last = await this.probeOnce(probeUser, assistantId, prompt);
    let attempts = 1;
    if (last.issues.length > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      last = await this.probeOnce(probeUser, assistantId, prompt);
      attempts = 2;
    }
    const ok = last.issues.length === 0;
    const msg = ok ? `ok (попыток: ${attempts})` : `x${attempts}: ${last.issues.join('; ')}`;

    try { await this.synthetic?.record('chat_quality_probe', ok, last.durationMs, msg); } catch {}
    if (!ok) {
      await this.alert(
        'quality_probe',
        `⚠️ КАЧЕСТВО: синтетическая проба чата УПАЛА (${attempts} попытки) — ${last.issues.join('; ')}.\n` +
        `Ответ: "${String(last.text).slice(0, 140)}"\n👉 Проверить r.linkeon.io / персона-промпт / модель.`,
      );
    } else {
      this.log.log(`quality probe ok (${last.durationMs}ms, attempts=${attempts})`);
    }
  }

  private cooled(kind: string): boolean {
    const last = this.lastAlertAt[kind] || 0;
    return Date.now() - last > ALERT_COOLDOWN_H * 3600_000;
  }
  private async alert(kind: string, text: string) {
    if (!this.cooled(kind)) return;
    this.lastAlertAt[kind] = Date.now();
    try { await sendTelegramAlert(text); } catch (e: any) { this.log.error(`quality alert send failed: ${e.message}`); }
  }

  async getOverview(): Promise<QualityOverview> {
    const alerts: string[] = [];

    // 1) Провалы платных провайдеров из-за баланса/квоты/лимита (наша сторона).
    const prov = await this.pg.query(
      `SELECT count(*)::int AS n, max(error_message) AS sample
         FROM video_jobs
        WHERE status = 'failed'
          AND updated_at > now() - ($1 || ' minutes')::interval
          AND (error_message ILIKE '%balance%' OR error_message ILIKE '%quota%'
            OR error_message ILIKE '%insufficient%' OR error_message ILIKE '%not enough%'
            OR error_message ILIKE '%exceeded%')`,
      [PROVIDER_FAIL_WINDOW_MIN],
    );
    const provCount = Number(prov.rows[0]?.n || 0);
    const provSample = prov.rows[0]?.sample || null;
    if (provCount > 0) {
      alerts.push(`provider_balance: ${provCount} video failures (${PROVIDER_FAIL_WINDOW_MIN}m)`);
    }

    // 2) Всплеск падений видео (доля failed за окно).
    const rate = await this.pg.query(
      `SELECT count(*) FILTER (WHERE status = 'failed')::int AS f, count(*)::int AS t
         FROM video_jobs WHERE created_at > now() - ($1 || ' minutes')::interval`,
      [FAILRATE_WINDOW_MIN],
    );
    const f = Number(rate.rows[0]?.f || 0);
    const t = Number(rate.rows[0]?.t || 0);
    const pct = t > 0 ? Math.round((f / t) * 100) : null;
    if (t >= FAILRATE_MIN_SAMPLE && pct !== null && pct >= FAILRATE_ALERT_PCT) {
      alerts.push(`video_failrate: ${f}/${t} (${pct}%) за ${FAILRATE_WINDOW_MIN}m`);
    }

    // 3) Качество чат-ответов из телеметрии chat_quality: пустые ответы и англ-утечки.
    const chatRes = await this.pg.query(
      `SELECT
         count(*) FILTER (WHERE COALESCE((props->>'deduped')::boolean, false) = false)::int AS responses,
         count(*) FILTER (WHERE COALESCE((props->>'empty')::boolean, false))::int AS empty,
         count(*) FILTER (WHERE COALESCE((props->>'english_leak')::boolean, false))::int AS leak,
         count(*) FILTER (WHERE COALESCE((props->>'deduped')::boolean, false))::int AS deduped
       FROM events WHERE name = 'chat_quality' AND ts > now() - ($1 || ' minutes')::interval`,
      [CHAT_WINDOW_MIN],
    );
    const responses = Number(chatRes.rows[0]?.responses || 0);
    const emptyN = Number(chatRes.rows[0]?.empty || 0);
    const leakN = Number(chatRes.rows[0]?.leak || 0);
    const dedupedN = Number(chatRes.rows[0]?.deduped || 0);
    const emptyPct = responses > 0 ? Math.round((emptyN / responses) * 100) : null;
    const leakPct = responses > 0 ? Math.round((leakN / responses) * 100) : null;
    if (responses >= CHAT_MIN_SAMPLE && emptyPct !== null && emptyPct >= EMPTY_ALERT_PCT) {
      alerts.push(`empty_responses: ${emptyN}/${responses} (${emptyPct}%)`);
    }
    if (responses >= CHAT_MIN_SAMPLE && leakPct !== null && leakPct >= LEAK_ALERT_PCT) {
      alerts.push(`english_leak: ${leakN}/${responses} (${leakPct}%)`);
    }

    return {
      generatedAt: new Date().toISOString(),
      providerFailures: { window_min: PROVIDER_FAIL_WINDOW_MIN, count: provCount, sample: provSample },
      videoFailureRate: { window_min: FAILRATE_WINDOW_MIN, failed: f, total: t, pct },
      chat: { window_min: CHAT_WINDOW_MIN, responses, empty: emptyN, emptyPct, englishLeak: leakN, leakPct, deduped: dedupedN },
      alerts,
    };
  }

  @Cron('0 */15 * * * *') // каждые 15 минут
  async check() {
    if (process.env.QUALITY_MONITOR_DISABLED === 'true') return;
    let ov: QualityOverview;
    try { ov = await this.getOverview(); }
    catch (e: any) { this.log.error(`quality check failed: ${e.message}`); return; }

    if (ov.providerFailures.count > 0) {
      await this.alert(
        'provider_balance',
        `⚠️ КАЧЕСТВО: платный провайдер отказывает пользователям.\n` +
        `${ov.providerFailures.count} видео-генераций упали за ${ov.providerFailures.window_min} мин с ошибкой баланса/квоты.\n` +
        `Пример: ${String(ov.providerFailures.sample || '').slice(0, 160)}\n` +
        `👉 Проверить/пополнить аккаунт провайдера (Kling / Google AI). Пока не пополнен — видео падает у всех.`,
      );
    }
    if (ov.videoFailureRate.pct !== null && ov.videoFailureRate.total >= FAILRATE_MIN_SAMPLE && ov.videoFailureRate.pct >= FAILRATE_ALERT_PCT) {
      await this.alert(
        'video_failrate',
        `⚠️ КАЧЕСТВО: высокая доля падений видео — ${ov.videoFailureRate.failed}/${ov.videoFailureRate.total} (${ov.videoFailureRate.pct}%) за ${ov.videoFailureRate.window_min} мин. Проверить пайплайн/провайдера.`,
      );
    }
    if (ov.chat.responses >= CHAT_MIN_SAMPLE && ov.chat.emptyPct !== null && ov.chat.emptyPct >= EMPTY_ALERT_PCT) {
      await this.alert(
        'empty_responses',
        `⚠️ КАЧЕСТВО: много пустых ответов ассистентов — ${ov.chat.empty}/${ov.chat.responses} (${ov.chat.emptyPct}%) за ${ov.chat.window_min} мин. Проверить r.linkeon.io / стриминг.`,
      );
    }
    if (ov.chat.responses >= CHAT_MIN_SAMPLE && ov.chat.leakPct !== null && ov.chat.leakPct >= LEAK_ALERT_PCT) {
      await this.alert(
        'english_leak',
        `⚠️ КАЧЕСТВО: всплеск англоязычных ответов — ${ov.chat.englishLeak}/${ov.chat.responses} (${ov.chat.leakPct}%) за ${ov.chat.window_min} мин. Проверить персона-промпт / r.linkeon.io.`,
      );
    }
  }
}
