import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';

/**
 * Models registry — what LLMs / image / audio / video models the platform
 * actually calls, who pays for them, and how heavily they're used.
 *
 * Two data sources joined:
 *  - A hardcoded `expected` catalog: every model that has a code path that
 *    can invoke it, with provider, purpose, and where it lives in the code.
 *    Kept in this file so it lives next to the other monitoring services
 *    and is editable as one git diff per change.
 *  - Dynamic usage from `events` table (claude_cli_call events at minimum,
 *    extensible to other model_call events when we instrument them).
 *
 * Combined view lets the admin spot: configured-but-unused models (drift),
 * unexpected model names showing up in events (rogue call sites), and
 * which models are actually dominating cost over the last 30 days.
 */

export type ModelProvider =
  | 'Anthropic' | 'OpenAI' | 'OpenRouter'
  | 'Google' | 'Kling' | 'ElevenLabs' | 'Yandex SpeechKit';

export type ModelKind = 'text' | 'image' | 'video' | 'audio' | 'embedding';

export interface ExpectedModel {
  provider: ModelProvider;
  model: string;          // canonical id used by the API
  kind: ModelKind;
  purpose: string;        // what we use it for
  caller: string;         // primary code path (file:func)
  via: 'OAuth' | 'API key' | 'CLI subscription';
}

const EXPECTED: ExpectedModel[] = [
  // ---- Claude (Anthropic) — via local `claude` CLI on prod (Max OAuth) ----
  { provider: 'Anthropic',  model: 'claude-haiku-4-5',  kind: 'text', purpose: 'Профиль из чата, суммаризация тикетов, авто-задачи', caller: 'common/ClaudeCliService → neo4j.consolidateFromChat, support, backlog.createFromTicket', via: 'CLI subscription' },
  { provider: 'Anthropic',  model: 'claude-sonnet-4-6', kind: 'text', purpose: 'Виртуальный продакт-менеджер: генерация продуктовых рекомендаций', caller: 'common/ClaudeCliService → vpm.generate', via: 'CLI subscription' },
  { provider: 'Anthropic',  model: 'claude-opus-4-7',   kind: 'text', purpose: 'Резерв для самых тяжёлых reasoning-задач (сейчас не зовётся регулярно)', caller: 'common/ClaudeCliService → manual / future', via: 'CLI subscription' },

  // ---- Anthropic API direct — fallback path / SDK calls ----
  { provider: 'Anthropic',  model: 'claude-haiku-4-5-20251001', kind: 'text', purpose: 'Anthropic SDK fallback при недоступности CLI/OAuth', caller: 'chat.service streamChat fallback path', via: 'API key' },
  { provider: 'Anthropic',  model: 'claude-sonnet-4-5',         kind: 'text', purpose: 'Анализ совместимости / поиск партнёров (старый код-пайп)', caller: 'misc/anthropic streaming', via: 'API key' },

  // ---- OpenRouter (dead until key returns; see backlog 9d2a6446) ----
  { provider: 'OpenRouter', model: 'anthropic/claude-haiku-4.5', kind: 'text', purpose: 'Tool-using ассистенты (Юля, MCP-loop). Сейчас silent-fail без OPENROUTER_API_KEY', caller: 'chat.service streamUniversalAgent', via: 'API key' },

  // ---- Image generation ----
  { provider: 'Google',     model: 'gemini-3.1-flash-image-preview', kind: 'image', purpose: 'Nano Banana — генерация изображений, авто-still для text2video', caller: 'misc.generateImage', via: 'API key' },
  { provider: 'Google',     model: 'gemini-3-pro-image-preview',     kind: 'image', purpose: 'Higher-quality image gen (опциональный режим)', caller: 'misc.generateImage(quality=pro)', via: 'API key' },
  { provider: 'Kling',      model: 'kling-v1',                       kind: 'image', purpose: 'Альтернативный image gen (older Kling)', caller: 'kling.generateImage', via: 'API key' },

  // ---- Video generation ----
  { provider: 'Kling',      model: 'kling-v1-6',     kind: 'video', purpose: 'Базовый видео-движок (text2video / image2video) — std/pro', caller: 'video.createJob', via: 'API key' },
  { provider: 'Kling',      model: 'kling-v2-master',kind: 'video', purpose: 'Премиум видео-движок (лучше для лиц)',                       caller: 'video.createJob (quality=master)', via: 'API key' },
  { provider: 'Kling',      model: 'kling-extend',   kind: 'video', purpose: 'Расширение существующего видео (+5с за вызов) для composed long-form', caller: 'video.advanceComposedJob → kling.createVideoExtendTask', via: 'API key' },
  { provider: 'Kling',      model: 'kling-lipsync',  kind: 'video', purpose: 'Лип-синк аудио → видео (создать или продолжить)',                       caller: 'video.createJob (mode=lipsync) → kling.createLipSyncTask', via: 'API key' },
  { provider: 'Google',     model: 'veo-3.1-generate-preview', kind: 'video', purpose: 'Veo 3.1 — генерация видео (9:16/16:9, talking-head, длинные ролики concat). Стоимость — оценка (см. VEO_EST_USD_PER_CALL)', caller: 'video.createJob (model=veo-3.1) → veo.generate', via: 'API key' },

  // ---- TTS (audio) ----
  { provider: 'ElevenLabs',     model: 'eleven_multilingual_v2', kind: 'audio', purpose: 'TTS для голосов hero/lawyer/coach/psy в SMM-пайпе', caller: 'smm-worker → ElevenLabs API', via: 'API key' },
  { provider: 'Yandex SpeechKit', model: 'yandexcloud-tts-v1',  kind: 'audio', purpose: 'TTS fallback для SMM-видео когда ElevenLabs не нужен', caller: 'smm-worker → speech.synthesize', via: 'API key' },
];

// Veo не логирует стоимость в событии veo_call, поэтому оцениваем расход как
// число вызовов × оценочную цену одного 8-сек клипа. ГРУБАЯ ОЦЕНКА — уточнить
// по реальному биллингу Google Veo 3.1 и поправить это число.
const VEO_EST_USD_PER_CALL = 2.0;

interface DynamicCounts {
  calls_30d: number;
  cost_usd_30d: number;
  calls_24h: number;
  last_seen: string | null;
}

export interface ModelStatus extends ExpectedModel {
  calls_30d: number;
  cost_usd_30d: number;
  calls_24h: number;
  last_seen: string | null;
}

export interface UnexpectedModel {
  model: string;
  source: string;          // event name where seen
  calls_30d: number;
  last_seen: string | null;
}

export interface ModelsRegistryOverview {
  generatedAt: string;
  expected: ModelStatus[];
  unexpected: UnexpectedModel[];
  totals: {
    by_provider: Array<{ provider: string; calls_30d: number; cost_usd_30d: number }>;
    by_kind: Array<{ kind: string; calls_30d: number; cost_usd_30d: number }>;
  };
}

@Injectable()
export class ModelsRegistryService implements OnModuleInit {
  private readonly log = new Logger(ModelsRegistryService.name);

  private cache: ModelsRegistryOverview | null = null;
  private lastRefreshAt = 0;

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    this.refresh().catch(() => {});
  }

  // Hourly: recompute usage. Cheap (a few aggregate queries) but no need
  // for sub-minute precision.
  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    await this.refresh();
  }

  async getOverview(): Promise<ModelsRegistryOverview> {
    // If cache is older than 10 min, refresh inline so /tech/models always
    // returns reasonably fresh data even between cron ticks.
    if (!this.cache || Date.now() - this.lastRefreshAt > 600_000) {
      await this.refresh();
    }
    return this.cache!;
  }

  private async refresh(): Promise<void> {
    const counts = await this.queryClaudeCliCounts();
    const expected: ModelStatus[] = EXPECTED.map((m) => {
      const c = counts.get(m.model) ?? { calls_30d: 0, cost_usd_30d: 0, calls_24h: 0, last_seen: null };
      return { ...m, ...c };
    });

    // Unexpected = models seen in events but NOT in the expected list.
    const expectedNames = new Set(EXPECTED.map((m) => m.model));
    const unexpected: UnexpectedModel[] = [];
    for (const [model, c] of counts.entries()) {
      if (!expectedNames.has(model)) {
        unexpected.push({
          model,
          source: 'events.claude_cli_call',
          calls_30d: c.calls_30d,
          last_seen: c.last_seen,
        });
      }
    }

    // Provider / kind rollups for the dashboard headline.
    const byProvider = new Map<string, { calls_30d: number; cost_usd_30d: number }>();
    const byKind     = new Map<string, { calls_30d: number; cost_usd_30d: number }>();
    for (const m of expected) {
      const p = byProvider.get(m.provider) ?? { calls_30d: 0, cost_usd_30d: 0 };
      p.calls_30d += m.calls_30d; p.cost_usd_30d += m.cost_usd_30d;
      byProvider.set(m.provider, p);
      const k = byKind.get(m.kind) ?? { calls_30d: 0, cost_usd_30d: 0 };
      k.calls_30d += m.calls_30d; k.cost_usd_30d += m.cost_usd_30d;
      byKind.set(m.kind, k);
    }

    this.cache = {
      generatedAt: new Date().toISOString(),
      expected,
      unexpected,
      totals: {
        by_provider: Array.from(byProvider.entries()).map(([provider, v]) => ({ provider, ...v }))
          .sort((a, b) => b.cost_usd_30d - a.cost_usd_30d || b.calls_30d - a.calls_30d),
        by_kind: Array.from(byKind.entries()).map(([kind, v]) => ({ kind, ...v }))
          .sort((a, b) => b.cost_usd_30d - a.cost_usd_30d || b.calls_30d - a.calls_30d),
      },
    };
    this.lastRefreshAt = Date.now();
  }

  // Aggregate per-model call counts from every per-provider event we
  // instrument. As of 2026-06-01 we track:
  //  - claude_cli_call (chat, vpm, backlog, tasks via ClaudeCliService)
  //  - kling_call (image + video + extend + lipsync via KlingService)
  // To add a new provider: emit `<provider>_call` events with at minimum
  // {model, ok, latency_ms} props, then add it to the UNION below.
  private async queryClaudeCliCounts(): Promise<Map<string, DynamicCounts>> {
    try {
      const r = await this.pg.query(
        `SELECT model,
                SUM(calls_24h)::int AS calls_24h,
                SUM(calls_30d)::int AS calls_30d,
                SUM(cost_usd_30d)::float AS cost_usd_30d,
                MAX(last_seen) AS last_seen
           FROM (
             SELECT COALESCE(props->>'model', 'unknown') AS model,
                    COUNT(*) FILTER (WHERE ts > now() - interval '24 hours')::int AS calls_24h,
                    COUNT(*) FILTER (WHERE ts > now() - interval '30 days')::int  AS calls_30d,
                    COALESCE(SUM((props->>'cost_usd')::numeric) FILTER (WHERE ts > now() - interval '30 days'), 0)::float AS cost_usd_30d,
                    MAX(ts) AS last_seen
               FROM events WHERE name = 'claude_cli_call'
               GROUP BY 1
             UNION ALL
             SELECT COALESCE(props->>'model', 'unknown') AS model,
                    COUNT(*) FILTER (WHERE ts > now() - interval '24 hours')::int AS calls_24h,
                    COUNT(*) FILTER (WHERE ts > now() - interval '30 days')::int  AS calls_30d,
                    0::float AS cost_usd_30d,
                    MAX(ts) AS last_seen
               FROM events WHERE name = 'kling_call'
               GROUP BY 1
             UNION ALL
             SELECT COALESCE(props->>'model', 'unknown') AS model,
                    COUNT(*) FILTER (WHERE ts > now() - interval '24 hours')::int AS calls_24h,
                    COUNT(*) FILTER (WHERE ts > now() - interval '30 days')::int  AS calls_30d,
                    -- Veo не отдаёт стоимость в событии → оцениваем: вызовы × оценка/клип.
                    (COUNT(*) FILTER (WHERE ts > now() - interval '30 days') * ${VEO_EST_USD_PER_CALL})::float AS cost_usd_30d,
                    MAX(ts) AS last_seen
               FROM events WHERE name = 'veo_call' AND COALESCE((props->>'ok')::boolean, true) = true
               GROUP BY 1
           ) sub
           GROUP BY model`,
      );
      const out = new Map<string, DynamicCounts>();
      for (const row of r.rows as any[]) {
        out.set(row.model, {
          calls_24h: Number(row.calls_24h) || 0,
          calls_30d: Number(row.calls_30d) || 0,
          cost_usd_30d: Number(row.cost_usd_30d) || 0,
          last_seen: row.last_seen ? new Date(row.last_seen).toISOString() : null,
        });
      }
      return out;
    } catch (e: any) {
      this.log.warn(`models registry query failed: ${e.message}`);
      return new Map();
    }
  }
}
