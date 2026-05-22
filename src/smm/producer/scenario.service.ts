// src/smm/producer/scenario.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { ClaudeCliService } from '../../common/services/claude-cli.service';
import { CreatorCampaignService } from './creator-campaign.service';
import { pickRandomVoice } from './voice-picker';
import { SmmCreatorCampaign } from '../entities/smm-creator-campaign.entity';
import {
  SmmScenario,
  rowToScenario,
  SmmDialogTurn,
  SmmBrollPrompt,
  SmmMood,
  SmmTtsTier,
  PremiumGenre,
  PremiumScene,
} from '../entities/smm-scenario.entity';
import { buildPremiumPromptSection } from './smm-producer.prompt';

export type SourceMode = 'auto' | 'topic' | 'trends';

export interface GenerateInput {
  campaignId: string;
  mode: SourceMode;
  count: number;
  topic?: string | null;
  trendsContext?: string;
  premiumGenre?: PremiumGenre | null;
}

type AssistantRoleId =
  | 'psy' | 'coach' | 'lawyer' | 'accountant' | 'marketer' | 'hr'
  | 'business' | 'copywriter' | 'astrologer' | 'numerologist'
  | 'humandesign' | 'gamepractic' | 'mindfulness' | 'assistant';

interface ClaudeScenarioJson {
  title: string;
  assistant_role: AssistantRoleId;
  mood: SmmMood;
  dialog: Array<{ speaker: 'hero' | 'assistant'; text: string; t_start: number; t_end: number }>;
  broll_prompts: Array<{ at_sec: number; type: 'ai_image' | 'stock_video'; prompt: string }>;
  scenes?: PremiumScene[];
}

const SYSTEM_PROMPT = `Ты — креативный сценарист коротких видео для Linkeon (платформа из 14 AI-ассистентов).

ЗАДАЧА: сгенерируй сценарии 60-секундных вертикальных видео в формате "герой пишет в чат → ассистент отвечает → проблема решена → CTA".

ПРАВИЛА:
1. Каждый сценарий — это реальная жизненная ситуация из жанра "узнаваемая боль", решение через 1-2 совета от ассистента.
2. dialog: 2-4 реплики, каждая 5-15 секунд. t_start/t_end в секундах с начала ролика (0-55 — последние 5 сек уйдут на CTA).
3. assistant_role — выбери НАИБОЛЕЕ ПОДХОДЯЩУЮ роль под тематику ролика:
   - psy — тревога, отношения, выгорание, сон, селф-вэлью, эмоции
   - coach — карьера, мотивация, режим дня, прокрастинация, цели (ICF-коуч)
   - lawyer — права на работе, договоры, долги, развод, защита прав потребителя
   - accountant — налоги ИП/ООО, бухучёт, отчётность, финансы бизнеса
   - marketer — продвижение, реклама, стратегия, аналитика рынка
   - hr — поиск работы, собеседования, оффер, переговоры о зарплате, карьерный путь
   - business — стратегия бизнеса, операционка, переговоры, масштабирование
   - copywriter — тексты для соцсетей, продающие тексты, заголовки
   - astrologer — астрология (ведическая Джйотиш), карта рождения, периоды планет
   - numerologist — нумерология, циклы жизни, число судьбы
   - humandesign — Human Design, тип, стратегия, авторитет, профиль
   - gamepractic — трансформационные игры, самоисследование через игру
   - mindfulness — осознанность, медитация, присутствие, эмоциональная регуляция
   - assistant — универсальный помощник по бытовым/общим задачам (используй только если ничто другое не подходит)
4. mood — одно из: dramatic | inspiring | calm | uplifting | tense | neutral
5. broll_prompts — ОБЯЗАТЕЛЬНО 1-3 кадра-вставки. КАЖДЫЙ объект ДОЛЖЕН содержать ВСЕ три поля:
   - at_sec (число!) — в какой момент ролика появляется (0..50). Распредели по таймлайну так, чтобы покрыть весь ролик: первый at_sec=0, последующие — равномерно до окончания диалога.
   - type — 'ai_image' для скриншотов/абстрактных сцен, 'stock_video' для людей/живых сцен.
   - prompt — короткий промпт на английском для Imagen/Pexels.
   Если at_sec отсутствует в твоём ответе — это БАГ. Никогда не пропускай его.
6. Реплики на русском, живой разговорный язык. БЕЗ канцелярита.

ФОРМАТ ОТВЕТА: чистый JSON-массив. Никаких пояснений до или после. Пример одного элемента:
{
  "title": "Тревога перед сном — за 30 секунд",
  "assistant_role": "psy",
  "mood": "calm",
  "dialog": [
    { "speaker": "hero", "text": "Не могу уснуть, мысли крутятся.", "t_start": 3, "t_end": 8 },
    { "speaker": "assistant", "text": "Попробуй технику 4-7-8: вдох на 4 счёта, задержка 7, выдох 8. Через минуту мозг переключится.", "t_start": 9, "t_end": 22 }
  ],
  "broll_prompts": [
    { "at_sec": 0, "type": "ai_image", "prompt": "Person lying in bed in dark room, anxious expression, vertical 9:16" },
    { "at_sec": 25, "type": "stock_video", "prompt": "woman breathing exercise relaxation" }
  ]
}`;

const CREATOR_MODE_SYSTEM_PROMPT = `Ты — креативный сценарист коротких вертикальных видео для эксперта-блогера.

ЗАДАЧА: сгенерируй сценарии 30-60-секундных вертикальных видео в формате
"зритель (роль 'hero') задаёт вопрос → эксперт (роль 'assistant') отвечает → итог + CTA".

ПАРАМЕТРЫ КАМПАНИИ:
- Тема: {topic}
- Жанр: {genre}
- CTA: {cta_label} → {cta_handle}

ПРАВИЛА:
1. Каждый сценарий — это узнаваемый запрос аудитории, на который у эксперта есть точный ответ.
2. dialog: 2-4 реплики, каждая 5-15 секунд. t_start/t_end в секундах (0-55).
3. speaker КАЖДОЙ реплики — СТРОГО одно из двух значений: 'hero' (зритель/аудитория) или 'assistant' (эксперт-автор). НИКАКИХ 'viewer', 'expert', 'user' и т.д. — только эти два литерала.
4. assistant_role фиксированно: 'expert' (не выбирай из 14 Linkeon-ролей).
5. mood — одно из: dramatic | inspiring | calm | uplifting | tense | neutral
6. broll_prompts — ОБЯЗАТЕЛЬНО 1-3 кадра. КАЖДЫЙ объект ДОЛЖЕН содержать at_sec (число), type ('ai_image' или 'stock_video'), prompt (английский, для Imagen/Pexels).
7. Реплики на русском, живой разговорный язык. БЕЗ канцелярита.

ФОРМАТ ОТВЕТА: чистый JSON-массив. Никаких пояснений до или после.`;

/**
 * Defense-in-depth: Claude haiku sometimes emits 'viewer'/'expert' speakers in
 * creator-mode despite the prompt. We coerce them to the canonical 'hero'/'assistant'
 * before persisting so downstream validators (PATCH route, TTS picker) don't fail.
 */
function normalizeSpeaker(raw: string): 'hero' | 'assistant' {
  const s = (raw ?? '').toLowerCase().trim();
  if (s === 'viewer' || s === 'user' || s === 'audience') return 'hero';
  if (s === 'expert' || s === 'author' || s === 'creator') return 'assistant';
  return s === 'hero' ? 'hero' : 'assistant';
}

@Injectable()
export class ScenarioService {
  private readonly logger = new Logger(ScenarioService.name);

  constructor(
    private readonly pg: PgService,
    private readonly claudeCli: ClaudeCliService,
    private readonly creatorCampaigns: CreatorCampaignService,
  ) {}

  async generate(input: GenerateInput): Promise<string[]> {
    const userMsg = this.buildUserMsg(input);
    const premiumGenre = input.premiumGenre ?? null;
    this.logger.log(`Generating ${input.count} scenarios, mode=${input.mode}, topic="${input.topic ?? ''}", premiumGenre=${premiumGenre ?? 'none'}`);

    const { systemPrompt: basePrompt, isLinkeonOfficial, creator } = await this.resolveSystemPrompt(input.campaignId, input.topic ?? null);
    const premiumSection = buildPremiumPromptSection(premiumGenre);
    const systemPrompt = premiumSection ? basePrompt + '\n\n' + premiumSection : basePrompt;

    // Premium-режим требует более длинных сценариев (6 сцен с motion_prompts) —
    // дефолтный 60s timeout не хватает, кладём 5 мин.
    const timeoutMs = premiumGenre ? 5 * 60_000 : 60_000;
    const text = (await this.claudeCli.text(userMsg, {
      system: systemPrompt,
      model: 'claude-haiku-4-5',
      timeoutMs,
    })).trim();
    if (!text) throw new Error('Claude returned empty text');
    const json = this.extractJson(text);
    const arr: ClaudeScenarioJson[] = JSON.parse(json);
    if (!Array.isArray(arr)) throw new Error('Claude returned non-array JSON');
    if (arr.length === 0) throw new Error('Claude returned empty array');

    const ttsTier: SmmTtsTier = 'economy';
    const ids: string[] = [];
    for (const s of arr.slice(0, input.count)) {
      const dialog: SmmDialogTurn[] = s.dialog.map((t) => ({
        speaker: normalizeSpeaker(t.speaker),
        text: t.text,
        tStart: t.t_start,
        tEnd: t.t_end,
      }));
      const brollPrompts: SmmBrollPrompt[] = (s.broll_prompts ?? []).map((b, i, arr) => ({
        atSec: typeof b.at_sec === 'number'
          ? b.at_sec
          : Math.round((i / Math.max(arr.length, 1)) * 40),
        type: b.type,
        prompt: b.prompt,
      }));

      const role = isLinkeonOfficial ? s.assistant_role : 'expert';
      const ttsVoiceId = isLinkeonOfficial ? null : pickRandomVoice(creator!.voiceGender);

      // Premium-mode: validate and extract scenes
      let scenes: PremiumScene[] | null = null;
      let klingSceneCount = 0;
      if (premiumGenre) {
        const rawScenes = s.scenes;
        if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
          throw new Error(`Claude returned no scenes array for premium genre "${premiumGenre}"`);
        }
        scenes = rawScenes as PremiumScene[];
        klingSceneCount = scenes.filter((sc) => sc.type === 'kling').length;
        if (klingSceneCount < 1) {
          throw new Error(`Claude returned no kling scenes for premium mode (genre="${premiumGenre}")`);
        }
        if (klingSceneCount > 6) {
          throw new Error(`Claude returned ${klingSceneCount} kling scenes — max 6 (cost-контроль)`);
        }
      }

      const r = await this.pg.query(
        `INSERT INTO smm_scenario
           (campaign_id, title, assistant_role, dialog, mood, broll_prompts, tts_tier, status, tts_voice_id,
            premium_genre, kling_scene_count, scenes_json)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, 'pending_review', $8, $9, $10, $11::jsonb)
         RETURNING id`,
        [
          input.campaignId, s.title, role,
          JSON.stringify(dialog), s.mood,
          JSON.stringify(brollPrompts), ttsTier,
          ttsVoiceId,
          premiumGenre,
          klingSceneCount,
          scenes !== null ? JSON.stringify(scenes) : null,
        ],
      );
      ids.push(r.rows[0].id);
    }
    this.logger.log(`Generated scenario ids: ${ids.join(', ')}`);
    return ids;
  }

  async regenerate(scenarioId: string, feedback: string): Promise<{ costUsd: number }> {
    const existing = await this.pg.query(
      `SELECT s.*, c.topic, c.source_mode FROM smm_scenario s
        JOIN smm_campaign c ON c.id = s.campaign_id
       WHERE s.id = $1`,
      [scenarioId],
    );
    if (existing.rows.length === 0) throw new Error(`scenario ${scenarioId} not found`);
    const row = existing.rows[0];

    const { systemPrompt, isLinkeonOfficial, creator } = await this.resolveSystemPrompt(row.campaign_id, row.topic ?? null);

    const userMsg = `Перегенерируй сценарий по этому фидбеку: "${feedback}"

Текущий сценарий:
${JSON.stringify({
  title: row.title, assistant_role: row.assistant_role, mood: row.mood,
  dialog: row.dialog, broll_prompts: row.broll_prompts,
}, null, 2)}

Сохрани общую тематику (${row.topic ?? 'auto'}), но переработай согласно фидбеку. Верни ОДИН JSON-объект (не массив) в том же формате.`;

    const cliRes = await this.claudeCli.textWithCost(userMsg, {
      system: systemPrompt,
      model: 'claude-haiku-4-5',
    });
    const text = cliRes.text.trim();
    if (!text) throw new Error('Claude returned empty text on regen');
    const json = this.extractJson(text);
    const s: ClaudeScenarioJson = JSON.parse(json);

    const dialog: SmmDialogTurn[] = s.dialog.map((t) => ({
      speaker: normalizeSpeaker(t.speaker), text: t.text, tStart: t.t_start, tEnd: t.t_end,
    }));
    const brollPrompts: SmmBrollPrompt[] = (s.broll_prompts ?? []).map((b, i, arr) => ({
      atSec: typeof b.at_sec === 'number'
        ? b.at_sec
        : Math.round((i / Math.max(arr.length, 1)) * 40),
      type: b.type,
      prompt: b.prompt,
    }));

    const role = isLinkeonOfficial ? s.assistant_role : 'expert';
    const ttsVoiceId = isLinkeonOfficial ? null : pickRandomVoice(creator!.voiceGender);

    await this.pg.query(
      `UPDATE smm_scenario
          SET title = $1, assistant_role = $2, dialog = $3::jsonb,
              mood = $4, broll_prompts = $5::jsonb, status = 'pending_review',
              tts_voice_id = $7
        WHERE id = $6`,
      [
        s.title, role, JSON.stringify(dialog),
        s.mood, JSON.stringify(brollPrompts), scenarioId,
        ttsVoiceId,
      ],
    );
    this.logger.log(`Regenerated scenario ${scenarioId} (cost=$${cliRes.costUsd.toFixed(4)})`);
    return { costUsd: cliRes.costUsd };
  }

  private async resolveSystemPrompt(
    campaignId: string,
    topic: string | null,
  ): Promise<{ systemPrompt: string; isLinkeonOfficial: boolean; creator: SmmCreatorCampaign | null }> {
    const campRes = await this.pg.query(
      `SELECT is_linkeon_official FROM smm_campaign WHERE id = $1`,
      [campaignId],
    );
    const isLinkeonOfficial = Boolean(campRes.rows[0]?.is_linkeon_official);

    if (isLinkeonOfficial) {
      return { systemPrompt: SYSTEM_PROMPT, isLinkeonOfficial: true, creator: null };
    }

    const creator = await this.creatorCampaigns.getByCampaign(campaignId);
    if (!creator) {
      throw new Error('Creator settings missing — call set_creator_campaign_settings first');
    }

    const systemPrompt = CREATOR_MODE_SYSTEM_PROMPT
      .replace('{topic}', topic ?? 'свободная')
      .replace('{genre}', creator.genre)
      .replace('{cta_label}', creator.ctaLabel)
      .replace('{cta_handle}', creator.ctaHandle);

    return { systemPrompt, isLinkeonOfficial: false, creator };
  }

  async getById(scenarioId: string): Promise<SmmScenario | null> {
    const r = await this.pg.query(`SELECT * FROM smm_scenario WHERE id = $1`, [scenarioId]);
    return r.rows[0] ? rowToScenario(r.rows[0]) : null;
  }

  async listByCampaign(campaignId: string): Promise<SmmScenario[]> {
    const r = await this.pg.query(
      `SELECT * FROM smm_scenario WHERE campaign_id = $1 ORDER BY created_at`,
      [campaignId],
    );
    return r.rows.map(rowToScenario);
  }

  private buildUserMsg(input: GenerateInput): string {
    const parts: string[] = [];
    parts.push(`Сгенерируй ${input.count} разных сценариев.`);
    if (input.mode === 'topic' && input.topic) {
      parts.push(`Тематика: "${input.topic}". Все сценарии — об этом, но с разных углов.`);
    } else if (input.mode === 'trends' && input.trendsContext) {
      parts.push(`Сейчас в русскоязычных соцсетях обсуждают:\n${input.trendsContext}\n\nВыбери ${input.count} самых "цепких" сюжетов и сделай по ним кейсы.`);
    } else {
      parts.push(`Тематика свободная — выбери из разных областей (отношения, работа, юр.вопросы, мотивация). Сценарии должны различаться по тематике и assistant_role.`);
    }
    parts.push(`Верни JSON-массив длиной ${input.count}. ТОЛЬКО JSON, никаких пояснений.`);
    return parts.join('\n\n');
  }

  private extractJson(text: string): string {
    // Strip code fence if present
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();
    return text;
  }
}
