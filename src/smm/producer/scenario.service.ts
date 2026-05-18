// src/smm/producer/scenario.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { ClaudeCliService } from '../../common/services/claude-cli.service';
import {
  SmmScenario,
  rowToScenario,
  SmmDialogTurn,
  SmmBrollPrompt,
  SmmMood,
  SmmTtsTier,
} from '../entities/smm-scenario.entity';

export type SourceMode = 'auto' | 'topic' | 'trends';

export interface GenerateInput {
  campaignId: string;
  mode: SourceMode;
  count: number;
  topic?: string | null;
  trendsContext?: string;
}

interface ClaudeScenarioJson {
  title: string;
  assistant_role: 'psy' | 'lawyer' | 'coach';
  mood: SmmMood;
  dialog: Array<{ speaker: 'hero' | 'assistant'; text: string; t_start: number; t_end: number }>;
  broll_prompts: Array<{ at_sec: number; type: 'ai_image' | 'stock_video'; prompt: string }>;
}

const SYSTEM_PROMPT = `Ты — креативный сценарист коротких видео для Linkeon (платформа AI-ассистентов: психолог, юрист, карьерный коуч).

ЗАДАЧА: сгенерируй сценарии 60-секундных вертикальных видео в формате "герой пишет в чат → ассистент отвечает → проблема решена → CTA".

ПРАВИЛА:
1. Каждый сценарий — это реальная жизненная ситуация из жанра "узнаваемая боль", решение через 1-2 совета от ассистента.
2. dialog: 2-4 реплики, каждая 5-15 секунд. t_start/t_end в секундах с начала ролика (0-55 — последние 5 сек уйдут на CTA).
3. assistant_role:
   - psy — тревога, отношения, выгорание, сон, селф-вэлью
   - lawyer — права на работе, договоры, долги, налоги, развод
   - coach — карьера, мотивация, режим дня, прокрастинация
4. mood — одно из: dramatic | inspiring | calm | uplifting | tense | neutral
5. broll_prompts — 1-2 кадра-вставки. type='ai_image' для скриншотов/абстрактных сцен, type='stock_video' для людей/живых сцен.
   - at_sec — в какой момент ролика появляется (0..50)
   - prompt — короткий промпт на английском для Imagen/Pexels
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

@Injectable()
export class ScenarioService {
  private readonly logger = new Logger(ScenarioService.name);

  constructor(
    private readonly pg: PgService,
    private readonly claudeCli: ClaudeCliService,
  ) {}

  async generate(input: GenerateInput): Promise<string[]> {
    const userMsg = this.buildUserMsg(input);
    this.logger.log(`Generating ${input.count} scenarios, mode=${input.mode}, topic="${input.topic ?? ''}"`);

    const text = (await this.claudeCli.text(userMsg, {
      system: SYSTEM_PROMPT,
      model: 'claude-haiku-4-5',
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
        speaker: t.speaker,
        text: t.text,
        tStart: t.t_start,
        tEnd: t.t_end,
      }));
      const brollPrompts: SmmBrollPrompt[] = (s.broll_prompts ?? []).map((b) => ({
        atSec: b.at_sec,
        type: b.type,
        prompt: b.prompt,
      }));

      const r = await this.pg.query(
        `INSERT INTO smm_scenario
           (campaign_id, title, assistant_role, dialog, mood, broll_prompts, tts_tier, status)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, 'pending_review')
         RETURNING id`,
        [
          input.campaignId, s.title, s.assistant_role,
          JSON.stringify(dialog), s.mood,
          JSON.stringify(brollPrompts), ttsTier,
        ],
      );
      ids.push(r.rows[0].id);
    }
    this.logger.log(`Generated scenario ids: ${ids.join(', ')}`);
    return ids;
  }

  async regenerate(scenarioId: string, feedback: string): Promise<void> {
    const existing = await this.pg.query(
      `SELECT s.*, c.topic, c.source_mode FROM smm_scenario s
        JOIN smm_campaign c ON c.id = s.campaign_id
       WHERE s.id = $1`,
      [scenarioId],
    );
    if (existing.rows.length === 0) throw new Error(`scenario ${scenarioId} not found`);
    const row = existing.rows[0];

    const userMsg = `Перегенерируй сценарий по этому фидбеку: "${feedback}"

Текущий сценарий:
${JSON.stringify({
  title: row.title, assistant_role: row.assistant_role, mood: row.mood,
  dialog: row.dialog, broll_prompts: row.broll_prompts,
}, null, 2)}

Сохрани общую тематику (${row.topic ?? 'auto'}), но переработай согласно фидбеку. Верни ОДИН JSON-объект (не массив) в том же формате.`;

    const text = (await this.claudeCli.text(userMsg, {
      system: SYSTEM_PROMPT,
      model: 'claude-haiku-4-5',
    })).trim();
    if (!text) throw new Error('Claude returned empty text on regen');
    const json = this.extractJson(text);
    const s: ClaudeScenarioJson = JSON.parse(json);

    const dialog: SmmDialogTurn[] = s.dialog.map((t) => ({
      speaker: t.speaker, text: t.text, tStart: t.t_start, tEnd: t.t_end,
    }));
    const brollPrompts: SmmBrollPrompt[] = (s.broll_prompts ?? []).map((b) => ({
      atSec: b.at_sec, type: b.type, prompt: b.prompt,
    }));

    await this.pg.query(
      `UPDATE smm_scenario
          SET title = $1, assistant_role = $2, dialog = $3::jsonb,
              mood = $4, broll_prompts = $5::jsonb, status = 'pending_review'
        WHERE id = $6`,
      [
        s.title, s.assistant_role, JSON.stringify(dialog),
        s.mood, JSON.stringify(brollPrompts), scenarioId,
      ],
    );
    this.logger.log(`Regenerated scenario ${scenarioId}`);
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
