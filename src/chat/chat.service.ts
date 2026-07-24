import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { KlingService } from '../misc/kling.service';
import { ChatToolsService } from './chat-tools';
import { SmmProducerToolsService } from '../smm/producer/smm-producer-tools.service';
import { ClaudeAgentService } from './claude-agent.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../events/events.service';
import axios from 'axios';
import { Request, Response } from 'express';
// Agent server at r.linkeon.io (remote Claude Code)

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  // Множитель цены за текст для агентов, идущих через SDK-путь
  // (streamUniversalAgent → r.linkeon.io). Применяется только для текстовых
  // токенов; MCP-инструменты (картинки, видео) списываются их сервисами
  // независимо и НЕ умножаются здесь. Маша считается отдельно — через
  // total_cost_usd из ClaudeCliService.
  private readonly SDK_TEXT_MULTIPLIER = 2;

  // Идемпотентность отправки: гасит дубли от повторных запросов (обрыв связи,
  // таймаут стрима, двойной тап) — второй идентичный запрос НЕ запускает агента
  // и НЕ списывает токены, пока первый «в полёте» или только что завершился.
  // In-memory (единый PM2-процесс). Инцидент 2026-07-12 (дубли картинок/текста).
  private readonly inflight = new Map<string, { state: 'running' | 'done'; ts: number }>();
  private readonly DEDUP_COOLDOWN_MS = 12000;
  private readonly DEDUP_RUNNING_TTL_MS = 600000; // страховка от «залипшего» running
  private dupKey(userId: string, assistantId: string, message: string): string {
    return `${userId}::${assistantId}::${(message || '').trim().slice(0, 300)}`;
  }

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly neo4j: Neo4jService,
    @Optional() private readonly kling: KlingService,
    private readonly tools: ChatToolsService,
    private readonly smmProducerTools: SmmProducerToolsService,
    private readonly claudeAgent: ClaudeAgentService,
    private readonly claudeCli: ClaudeCliService,
    @Optional() private readonly tasksService?: TasksService,
    @Optional() private readonly events?: EventsService,
  ) {}

  // Эвристика англ-утечки: длинный ответ, в котором почти нет кириллицы (после
  // вырезания кода/URL) — вероятно, ассистент «съехал» на английский или утёк
  // служебный вывод. Для агрегатной телеметрии (не для блокировки).
  private looksEnglishLeak(text: string): boolean {
    if (!text) return false;
    const cleaned = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/`[^`]*`/g, ' ');
    const letters = (cleaned.match(/\p{L}/gu) || []).length;
    if (letters < 40) return false;
    const cyr = (cleaned.match(/[Ѐ-ӿ]/g) || []).length;
    return cyr / letters < 0.1;
  }

  async streamChat(
    userId: string,
    message: string,
    assistantId: string,
    sessionId: string,
    profileText: string,
    res: Response,
    req?: Request,
    // «Чистый лист»: история и запись идут в отдельную fresh-сессию (sessionId),
    // прошлые задачи в промпт не инжектятся. Профиль ЧИТАЕТСЯ (вариант A) и
    // ФОРМИРУЕТСЯ (consolidateFromChat работает от переданных сообщений).
    fresh: boolean = false,
  ): Promise<void> {
    // Get agent
    // Custom-agent branch: "custom:<uuid>" references user-created agents.
    // Owner-check is enforced — a user cannot use another user's custom agent.
    let agent: any;
    if (assistantId.startsWith('custom:')) {
      const customId = assistantId.substring('custom:'.length);
      const customRes = await this.pg.query(
        `SELECT id, name, description, system_prompt FROM custom_agents
          WHERE id = $1 AND owner_user_id = $2
          LIMIT 1`,
        [customId, userId],
      );
      if (customRes.rows[0]) {
        // Shape matches the agents table row used downstream
        agent = {
          id: `custom:${customRes.rows[0].id}`,
          name: customRes.rows[0].name,
          display_name: customRes.rows[0].name,
          description: customRes.rows[0].description || '',
          system_prompt: customRes.rows[0].system_prompt || '',
        };
      } else {
        // Orphaned / not owned — fall back to the platform default agent (Роман, id=1)
        this.logger.warn(`custom agent ${customId} not found or not owned by ${userId}, falling back to default`);
        const fallbackRes = await this.pg.query('SELECT * FROM agents ORDER BY id LIMIT 1');
        agent = fallbackRes.rows[0];
      }
    } else {
      const isNumeric = /^\d+$/.test(assistantId);
      const agentRes = isNumeric
        ? await this.pg.query('SELECT * FROM agents WHERE id = $1 LIMIT 1', [parseInt(assistantId, 10)])
        : await this.pg.query('SELECT * FROM agents WHERE name = $1 LIMIT 1', [assistantId]);
      agent = agentRes.rows[0];
    }
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Get chat history (individual rows: session_id, sender_type, content)
    // fresh: история и запись — в отдельной fresh-сессии из controller'а.
    const chatSessionId = fresh ? sessionId : `${userId}_${assistantId}`;
    const histRes = await this.pg.query(
      `SELECT sender_type, content FROM custom_chat_history
       WHERE session_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [chatSessionId],
    );
    const recentHistory = histRes.rows.reverse().map(r => ({
      type: r.sender_type === 'human' ? 'user' : 'assistant',
      content: r.content,
    }));

    // Check token balance (skip for first greeting)
    const isGreetingMsg = recentHistory.length === 0 && /привет|расскажи про себя|hello|hi$/i.test(message.trim());
    if (!isGreetingMsg) {
      const balRes = await this.pg.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
      const balance = balRes.rows[0]?.tokens || 0;
      if (balance <= 0) {
        res.status(200);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const noTokensMsg = '⚠️ **Недостаточно токенов**\n\nВаш баланс исчерпан. Пополните баланс, чтобы продолжить общение с ассистентами.\n\n👉 [Пополнить баланс](/chat?view=tokens)';
        res.write(JSON.stringify({ type: 'begin' }) + '\n');
        res.write(JSON.stringify({ type: 'item', content: noTokensMsg }) + '\n');
        res.write(JSON.stringify({ type: 'end', content: noTokensMsg, usage: { input: 0, output: 0, total: 0 } }) + '\n');
        res.end();
        return;
      }
    }

    // Route SMM-Producer agent to its dedicated Claude Agent SDK path (Plan 4e).
    // Uses OAuth via ~/.claude/.credentials.json — no ANTHROPIC_API_KEY needed.
    // Multi-turn handled via session resume (stored in profile_data.smm_sdk_session_id).
    if (agent?.name === 'smm_producer') {
      // Set streaming headers
      res.status(200);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Persist the user message to chat history (so it shows up on history reload).
      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
         VALUES ($1, 'human', $2, $3, 'text')`,
        [chatSessionId, agent.id, message],
      );

      const adminRes = await this.pg.query(
        `SELECT isadmin FROM ai_profiles_consolidated WHERE user_id = $1`,
        [userId],
      );
      const isAdmin = Boolean(adminRes.rows[0]?.isadmin);
      const ctx = { userId, isAdmin };
      try {
        await this.claudeAgent.streamSmmProducer(ctx, message, chatSessionId, agent.id, res);
      } catch (err: any) {
        this.logger.error(`SMM streaming failed: ${err.message}`);
        // Best-effort error event; res may already be ended.
        try {
          res.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
          res.end();
        } catch {}
      }
      return;
    }

    // Все агенты кроме Маши идут через streamUniversalAgent → r.linkeon.io
    // (MCP image/video tools, code execution). Маша остаётся локально потому
    // что её метафорические карты подмешиваются регуляркой post-processing'ом
    // из metaphor_cards postgres-таблицы (см. ниже) — r.linkeon.io об этом
    // не знает.
    if (agent.id !== 3) {
      return this.streamUniversalAgent(
        userId, message, String(assistantId), String(agent.id),
        recentHistory, profileText, res,
        agent.name, agent.description || '', agent.system_prompt || '',
        req, fresh, chatSessionId,
      );
    }

    // Build system prompt with platform context + profile.
    // Use display_name (e.g. Юлия) instead of internal name (smm_producer) so the
    // assistant introduces coworkers with their human-friendly names.
    const allAgents = await this.pg.query('SELECT name, COALESCE(display_name, name) AS display_name, description, system_prompt FROM agents ORDER BY id');
    const agentsList = allAgents.rows.map(a => `${a.display_name} — ${a.description}`).join(', ');

    const otherAgents = allAgents.rows
      .filter(a => a.name !== agent.name)
      .map(a => `${a.display_name} — ${a.description}`)
      .join(', ');

    const platformContext = `ТЫ — ${agent.name}, ${agent.description || 'ассистент'}. Всегда представляйся именно этим именем.

О КОНТЕКСТЕ И ПЛАТФОРМЕ
Ты работаешь в LINKEON.IO — нейросети для роста и развития бизнеса. Здесь ИИ помогает, люди направляют, а партнёры ускоряют рост бизнеса. Платформа соединяет предпринимателей с ИИ-ассистентами и помогает находить партнёров через Нетворкинг.
Ключевые разделы:
• Чат с ассистентами — где ты сейчас. Другие ассистенты: ${otherAgents}. Предложи переключиться в левом верхнем углу.
• Нетворкинг — поиск партнёров и проверка совместимости по ценностям
• Генерация изображений — создание визуалов для бизнеса
• Мой профиль — ценности, навыки, интересы, намерения пользователя
При первом приветствии кратко представься и упомяни других ассистентов. Используй только текст без таблиц.
Ты умеешь генерировать изображения (tool generate_image — через Google Imagen 4.0 Ultra с фолбэком на Nano Banana 2 / Nano Banana Pro, параметр quality: std|hd; hd = 4K и лучший рендер текста), редактировать уже созданные картинки (tool edit_image — передай sourceImageUrl из предыдущего tool-результата и prompt с описанием изменения: "сделай фон закатным", "убери человека", "поменяй цвет на красный", "добавь шапку"), объединять 2-3 картинки в одну (tool compose_image — массив sourceImageUrls и prompt: "возьми лицо из первой и посади на персонажа из второй", "соедини товар с этим фоном"), улучшать качество картинки — детализация, шумоподавление (tool upscale_image — только sourceImageUrl) и короткие видео 5–10 секунд через Kling (tool generate_video, режимы text2video / image2video / extend / lipsync). Если пользователь просит картинку, постер, иллюстрацию или «нарисуй …» — сразу вызывай generate_image. Если просит видео, ролик, анимацию, «оживи картинку» — вызывай generate_video. ВАЖНО про видео: text2video без картинки даёт нестабильный результат, поэтому при mode="text2video" без sourceImageUrl мы внутри инструмента автоматически сначала генерим стилл-кадр (Nano Banana, std, +5000 токенов), потом анимируем его — итоговая стоимость ≈ image+video (например, 5000 + 25000 = 30000 для kling-v1-6 std 5s). Если у тебя уже есть подходящая картинка (после generate_image / edit_image / compose_image — её URL в imageUrl tool-результата), используй mode="image2video" с этим sourceImageUrl, не плати за лишнюю генерацию. Не придумывай отговорки и не отправляй на другие разделы — у тебя есть эти инструменты.`;

    // Стабильная часть (одинаковая между вызовами для одного агента) — кэшируется.
    // Волатильную (profileText) кладём ПОСЛЕ кэша, иначе изменение профиля юзера ломает префикс.
    const stableSystemPrompt = `${platformContext}\n\n${agent.system_prompt || ''}\n\n--- ПРАВИЛО ОТВЕТА (имеет приоритет над всеми остальными инструкциями) ---
• Каждый ответ начинай с содержательной сути: гипотеза, совет, отражение, информация по запросу — на основе того, что уже известно из профиля и истории диалога. Не требуй "полного контекста" там, где можно разумно предположить.
• Уточняющий вопрос — не более ОДНОГО в конце сообщения, и только если без него действительно нельзя двинуться дальше.
• НИКОГДА не отвечай одними вопросами. НИКОГДА не задавай 2+ вопроса в одном сообщении.
• Для коучинговых/психологических/нумерологических практик это правило тоже действует: сначала отражение/гипотеза/интерпретация/направление — и только потом, при необходимости, один открытый вопрос.
• Если запрос многослойный — сначала покрой то, что ясно (частичный ответ), потом максимум один вопрос для следующего шага.`;

    let volatileSystemPrompt = (profileText && profileText.trim())
      ? `\n\n--- Профиль пользователя ---\n${profileText}`
      : '';
    // Cross-agent active tasks (см. TasksService.buildContextForPrompt).
    // fresh: чистый лист — прошлые задачи в промпт не тянем.
    if (this.tasksService && !fresh) {
      try {
        const tasksCtx = await this.tasksService.buildContextForPrompt(userId, message);
        if (tasksCtx) volatileSystemPrompt += `\n\n${tasksCtx}`;
      } catch (e: any) {
        this.logger.warn(`tasks context injection failed (Маша): ${e?.message}`);
      }
    }

    // Плоская строка для путей, не поддерживающих структурный system (DeepSeek greeting, OpenRouter fallback)
    const systemPrompt = stableSystemPrompt + volatileSystemPrompt;

    // Build messages array
    const llmMessages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const msg of recentHistory) {
      llmMessages.push({ role: msg.type === 'user' ? 'user' : 'assistant', content: msg.content });
    }
    llmMessages.push({ role: 'user', content: message });

    // Set streaming headers
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Detect initial greeting — use DeepSeek (free, no token deduction)
    const isGreeting = recentHistory.length === 0 && /привет|расскажи про себя|hello|hi$/i.test(message.trim());
    if (isGreeting && process.env.DEEPSEEK_API_KEY) {
      res.write(JSON.stringify({ type: 'begin' }) + '\n');
      try {
        const dsResp = await axios.post('https://api.deepseek.com/chat/completions', {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          max_tokens: 2048,
        }, {
          headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        });
        const greetText = this.stripToolTags(dsResp.data?.choices?.[0]?.message?.content || 'Привет! Чем могу помочь?');
        res.write(JSON.stringify({ type: 'item', content: greetText }) + '\n');
        res.write(JSON.stringify({ type: 'end', content: greetText, usage: { input: 0, output: 0, total: 0 } }) + '\n');
        res.end();
        setImmediate(async () => {
          try { await this.saveChatHistory(userId, String(assistantId), message, greetText, 0, fresh ? chatSessionId : undefined); } catch {}
          // No token deduction for greeting
        });
        return;
      } catch (e) {
        this.logger.error(`DeepSeek greeting error: ${e.message}`);
        // Fall through to Anthropic
      }
    }

    // Маша-only путь (agent.id === 3): остальные агенты выше уже ушли в streamUniversalAgent.
    // Один вызов ClaudeCli (OAuth), потом post-processing для инжекта метафорической карты,
    // потом single 'item' + 'end' событие. Без streaming, без CHAT_TOOLS — Маша их не звала.
    res.write(JSON.stringify({ type: 'begin' }) + '\n');

    let inputTokens = 0;
    let outputTokens = 0;
    let rawText = '';

    // Собираем prompt: история + текущая реплика. systemPrompt уже включает
    // platformContext + agent.system_prompt + правило ответа + profileText + tasks ctx.
    const priorTurns = llmMessages
      .slice(0, -1) // last is current message — добавляем отдельно как USER
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');
    const fullPrompt = priorTurns ? `${priorTurns}\n\nUSER: ${message}` : `USER: ${message}`;

    try {
      const r = await this.claudeCli.textWithCost(fullPrompt, {
        system: systemPrompt,
        // 'opus' — алиас последнего Opus (сейчас claude-opus-5); заметно дороже
        // Haiku, биллинг юзеру идёт от costUsd, так что цена сообщения вырастет.
        model: 'opus',
        timeoutMs: 90_000,
      });
      rawText = r.text || '';
      // Биллинг как у Юли: $1 = 100k Linkeon-tokens. Кладём всё в outputTokens
      // (split input/output здесь не информативен — берём суммарную стоимость).
      outputTokens = Math.ceil(r.costUsd * 100_000);
      this.logger.log(`Маша claude CLI: cost=$${r.costUsd.toFixed(4)} tokens=${outputTokens}`);
    } catch (e: any) {
      this.logger.error(`Маша claude CLI error: ${e.message}`);
      rawText = 'Извините, временные проблемы со связью. Попробуйте ещё раз через минуту.';
    }

    // Clean and post-process the full response
    let fullText = this.stripToolTags(rawText);

    // Маша иногда говорит «вот карта», «вытяни карту» — backend ловит regex'ом
    // и подвешивает реальную карту из metaphor_cards (postgres). LLM сама про
    // URL не знает, она просто описывает образ.
    const cardPattern = /(?:get_metaphor_card|images\.linkeon\.io|image_url|вот.*карт|первая карта|следующая карта|покажу.*карт|новая карта|вытяни.*карт|твоя карта|вот она|карту для тебя|достаю карту|тяну карту|открываю карту|Что ты видишь на этой карте|Какие чувства.*вызывает)/i;
    const cardMatch = cardPattern.test(rawText) || /карт/i.test(rawText);
    if (cardMatch) {
      try {
        const cardUrl = await this.getRandomMetaphorCard(userId);
        if (cardUrl) {
          fullText = `${fullText.trim()}\n\n![Метафорическая карта](${cardUrl})`;
        }
      } catch (e: any) {
        this.logger.error(`Metaphor card error: ${e.message}`);
      }
    }

    const tokensUsed = inputTokens + outputTokens;
    res.write(JSON.stringify({ type: 'item', content: fullText }) + '\n');
    res.write(JSON.stringify({ type: 'end', content: fullText, usage: { input: inputTokens, output: outputTokens, total: tokensUsed } }) + '\n');
    res.end();

    // Async: save to DB and consolidate profile after response sent
    setImmediate(async () => {
      try {
        const tokensUsed = inputTokens + outputTokens;
        await this.saveChatHistory(userId, String(assistantId), message, fullText, tokensUsed, fresh ? chatSessionId : undefined);
        await this.addTokenTask(userId, inputTokens, outputTokens, String(agent.id));
        // Extract profile entities from conversation — работает и в fresh-режиме:
        // «чистый лист» не тянет прошлый контекст, но профиль формирует.
        if (this.neo4j) {
          await this.neo4j.consolidateFromChat(userId, String(assistantId), message, fullText);
        }
        // Operational task memory (cross-agent). В fresh-режиме выключено:
        // чистый лист не должен порождать боковых задач.
        if (this.tasksService && !fresh) {
          try { await this.tasksService.extractFromTurn(userId, String(assistantId), message, fullText); } catch {}
        }
      } catch (e) {
        this.logger.error(`Post-chat save error: ${e.message}`);
      }
    });
  }

  /**
   * Быстрый heuristic: распознать явную просьбу сгенерировать картинку или видео.
   * Используется для Романа, чтобы такие запросы шли по нашей Kling-цепочке, а не во внешний воркер.
   */
  private detectMediaIntent(message: string): 'image' | 'video' | 'edit' | null {
    const m = (message || '').toLowerCase();
    if (/(созда[йи]|сгенериру[йи]|сделай|нарисуй|анимируй|ожив[иь])\s*[^.\n]{0,80}\b(видео|ролик|анимаци|клип)/i.test(m)
        || /(make|generate|create)\s+[^.\n]{0,50}\bvideo\b/i.test(m)) {
      return 'video';
    }
    if (/(нарисуй|созда[йи]|сгенериру[йи]|сделай)\s*[^.\n]{0,80}\b(картинк|изображени|постер|иллюстраци|логотип|рисунок|арт|фото)/i.test(m)
        || /(draw|generate|create|make)\s+[^.\n]{0,50}\b(image|picture|illustration|poster)\b/i.test(m)) {
      return 'image';
    }
    // Edit intent — only trigger when referring to existing image (фон/цвет/надпись etc.)
    if (/(поменяй|замени|измени|убери|добавь|отредактируй|перекрась|дорисуй)\s+[^.\n]{0,60}\b(фон|цвет|небо|текст|надпись|лицо|стиль|шапк|очки|одежд|персонаж|объект|картинк|изображен|фото)/i.test(m)
        || /сделай\s+[^.\n]{0,40}\b(темнее|светлее|ярче|контрастн|чёрно-бел|чернобел|красн|син|зелён|жёлт|закатн|вечерн)/i.test(m)) {
      return 'edit';
    }
    // Compose intent
    if (/(объедини|соедини|совмести|скомбинируй|скомпону[йи])\s+[^.\n]{0,60}\b(картин|изображен|фото)/i.test(m)
        || /(возьми|помести|вставь)\s+[^.\n]{0,80}\b(из\s+(перв|втор|трет)|с\s+(перв|втор)|фото|картин)/i.test(m)) {
      return 'edit';
    }
    return null;
  }

  private extractYouTubeIds(text: string): string[] {
    const ids = new Set<string>();
    const patterns = [
      /(?:youtube\.com\/watch\?[^\s]*?v=)([a-zA-Z0-9_-]{11})/g,
      /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/g,
      /(?:youtube\.com\/(?:embed|shorts|v)\/)([a-zA-Z0-9_-]{11})/g,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) ids.add(m[1]);
    }
    return Array.from(ids).slice(0, 2); // cap to 2 videos per message
  }

  private async fetchYouTubeTranscript(videoId: string): Promise<string | null> {
    try {
      const { YoutubeTranscript } = require('youtube-transcript');
      const items = await YoutubeTranscript.fetchTranscript(videoId);
      if (!Array.isArray(items) || items.length === 0) return null;
      const text = items.map((x: any) => x.text).join(' ').replace(/\s+/g, ' ').trim();
      return text.length > 0 ? text.slice(0, 20000) : null; // cap at ~20k chars
    } catch (e: any) {
      this.logger.warn(`YouTube transcript fetch failed for ${videoId}: ${e.message}`);
      return null;
    }
  }

  private async streamUniversalAgent(
    userId: string,
    message: string,
    assistantId: string,
    agentId: string,
    recentHistory: { type: string; content: string }[],
    profileText: string,
    res: Response,
    agentName: string = 'Роман',
    agentDescription: string = '',
    agentSystemPrompt: string = '',
    req?: Request,
    fresh: boolean = false,
    freshSessionId?: string,
  ): Promise<void> {
    const AGENT_URL = process.env.AGENT_URL || 'https://r.linkeon.io';

    // Идемпотентность: если идентичный запрос уже «в полёте» или только что
    // завершился — не гоняем агента и не списываем токены второй раз.
    const dkey = this.dupKey(userId, assistantId, message);
    {
      const nowTs = Date.now();
      const ex = this.inflight.get(dkey);
      const blocked = ex && (
        (ex.state === 'running' && nowTs - ex.ts < this.DEDUP_RUNNING_TTL_MS) ||
        (ex.state === 'done' && nowTs - ex.ts < this.DEDUP_COOLDOWN_MS)
      );
      if (blocked) {
        this.logger.log(`dedup: duplicate send skipped for ${userId}_${assistantId} (state=${ex!.state})`);
        this.events?.track('chat_quality', {
          userId, sessionId: `${userId}_${assistantId}`,
          props: { assistant_id: assistantId, deduped: true },
        });
        res.status(200);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const note = ex!.state === 'running'
          ? 'Секунду — я ещё обрабатываю ваш предыдущий такой же запрос. Ответ появится здесь, не отправляйте повторно.'
          : 'Этот запрос я только что обработал — ответ выше. Если нужно заново, немного переформулируйте.';
        try {
          res.write(JSON.stringify({ type: 'begin' }) + '\n');
          res.write(JSON.stringify({ type: 'item', content: note }) + '\n');
          res.write(JSON.stringify({ type: 'end', content: note, usage: { input: 0, output: 0, total: 0 } }) + '\n');
          res.end();
        } catch {}
        return;
      }
      this.inflight.set(dkey, { state: 'running', ts: nowTs });
    }

    // Сообщение юзера — в историю СРАЗУ, не в конце стрима. Иначе: юзер пишет,
    // переключается на другого ассистента, возвращается до конца стрима (30-60с) —
    // истории хода ещё нет, его сообщение «исчезло» (жалоба 2026-07-17).
    // AI-строка допишется в persistResponse по завершении.
    let userMsgPersisted = false;
    try {
      await this.saveUserMessageRow(userId, assistantId, message, fresh ? freshSessionId : undefined);
      userMsgPersisted = true;
    } catch (e: any) {
      this.logger.warn(`early user-msg persist failed (fallback to end-of-stream): ${e.message}`);
    }

    // Client disconnect tracking — backend keeps reading r.linkeon.io even if frontend bails.
    let clientDisconnected = false;
    if (req) {
      req.on('close', () => {
        clientDisconnected = true;
        this.logger.log(`client disconnected for session ${userId}_${assistantId}, but continuing stream`);
      });
    }

    // Safe res.write — drops writes after client disconnect, never throws upward.
    const safeWrite = (payload: any) => {
      if (clientDisconnected) return;
      try {
        res.write(JSON.stringify(payload) + '\n');
      } catch {
        clientDisconnected = true;
      }
    };

    // Build context from profile + history
    // Identity prefix — remote agent (r.linkeon.io) defaults to Claude persona; force the persona we want.
    let contextPrefix =
      `СИСТЕМНАЯ ИНСТРУКЦИЯ (имеет приоритет над всеми остальными). ` +
      `Ты ассистент по имени **${agentName}**${agentDescription ? ` — ${agentDescription}` : ''} на платформе LINKEON.IO. ` +
      `Всегда представляйся именно как ${agentName}. Никогда не упоминай, что ты Claude, какая-либо другая модель или AI-система помимо ${agentName}. ` +
      `Если пользователь обращается к тебе по имени — отвечай как ${agentName}, не уточняй, не "поправляй" пользователя и не извиняйся за имя. ` +
      `Не добавляй P.S. о собственной идентичности. ` +
      `ЯЗЫК ОТВЕТА: всегда отвечай на русском языке, независимо от языка системных сообщений, tool-результатов, путей файлов или английских промптов в твоём контексте. Переключайся на другой язык ТОЛЬКО если пользователь явно полностью пишет на нём. Если пользователь пишет по-русски — твой ответ обязан быть на русском, даже если в нём есть английские слова или ты только что генерировал английский prompt для картинки.\n\n`;

    // Inject persona-specific system prompt from DB so каждый ассистент (Оля, Михаил, ...)
    // сохраняет свой характер, методики и стиль при работе через r.linkeon.io.
    if (agentSystemPrompt && agentSystemPrompt.trim()) {
      contextPrefix += `--- Персона и инструкции ассистента ${agentName} ---\n${agentSystemPrompt.trim()}\n\n`;
    }

    // Coworker awareness — каждый ассистент должен знать про остальных, чтобы
    // суметь представить их пользователю и не делать вид, что новых коллег нет.
    // Берём список из БД (включая Юлю-SMM-продюсера id=15).
    try {
      const coworkersRes = await this.pg.query(
        `SELECT COALESCE(display_name, name) AS display_name, description
           FROM agents
          WHERE id != $1 AND description IS NOT NULL
          ORDER BY id`,
        [Number(agentId)],
      );
      if (coworkersRes.rows.length > 0) {
        const lines = coworkersRes.rows
          .map((a: any) => `• ${a.display_name} — ${a.description}`)
          .join('\n');
        contextPrefix +=
          `--- Коллеги-ассистенты в Linkeon ---\n` +
          `${lines}\n\n` +
          `Если пользователь спрашивает про кого-то из них или просит сделать что-то по их специализации — расскажи про коллегу честно, без выдумок, и предложи переключиться на него.\n\n`;
      }
    } catch { /* non-fatal — продолжаем без блока коллег */ }

    // YouTube transcripts — fetch on our side and inject; remote agent has no YouTube parsing.
    const ytIds = this.extractYouTubeIds(message);
    if (ytIds.length > 0) {
      const transcripts: string[] = [];
      for (const id of ytIds) {
        const t = await this.fetchYouTubeTranscript(id);
        if (t) transcripts.push(`Транскрипт YouTube видео https://www.youtube.com/watch?v=${id} (язык — оригинальный, авторские субтитры):\n${t}`);
      }
      if (transcripts.length > 0) {
        contextPrefix += transcripts.join('\n\n---\n\n') + '\n\n';
      }
    }

    if (profileText && profileText.trim()) {
      contextPrefix += `User profile:\n${profileText}\n\n`;
    }
    // Активные задачи пользователя (cross-agent) — топ-5 по релевантности
    // к текущей реплике. Юзер видит ассистентов как продолжающих контекст
    // незаконченных дел, а не отвечающих с нуля. fresh: чистый лист — не тянем.
    if (this.tasksService && !fresh) {
      try {
        const tasksCtx = await this.tasksService.buildContextForPrompt(userId, message);
        if (tasksCtx) contextPrefix += tasksCtx + '\n';
      } catch (e: any) {
        this.logger.warn(`tasks context injection failed: ${e?.message}`);
      }
    }
    if (recentHistory.length > 0) {
      // stripLeakedToolSyntax: заражённая история заставляет модель имитировать
      // текстовый tool-синтаксис вместо реальных вызовов (см. инцидент 2026-07-10).
      const historyLines = recentHistory
        .slice(-6)
        .map(m => `${m.type === 'user' ? 'User' : 'Assistant'}: ${this.stripLeakedToolSyntax(m.content)}`)
        .join('\n');
      contextPrefix += `Recent conversation context:\n${historyLines}\n\n`;
    }

    const prompt = contextPrefix + message;

    // Set streaming headers
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    safeWrite({ type: 'begin' });

    // Heartbeat: send a no-op ping every 25s while r.linkeon.io is silent (long tool-runs)
    // to prevent nginx idle-timeout (proxy_read_timeout) from killing the connection.
    let lastDataAt = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastDataAt > 20000) {
        // Frontend ChatInterface ignores unknown types — safely no-op on client.
        safeWrite({ type: 'ping' });
      }
    }, 25000);

    const streamStartTime = Date.now();
    const chunks: string[] = []; // hoisted so catch block can access partial response

    // Single persistence point — dedupe via `saved` flag so success and error paths
    // both call but only one actually writes.
    let saved = false;
    const persistResponse = async (final: boolean) => {
      if (saved) return;
      saved = true;
      // Снимаем in-flight метку → включаем короткий кулдаун на идентичный повтор,
      // затем чистим ключ, чтобы карта не росла.
      this.inflight.set(dkey, { state: 'done', ts: Date.now() });
      setTimeout(() => {
        const e = this.inflight.get(dkey);
        if (e && e.state === 'done' && Date.now() - e.ts >= this.DEDUP_COOLDOWN_MS) this.inflight.delete(dkey);
      }, this.DEDUP_COOLDOWN_MS + 2000);
      const fullText = this.stripLeakedToolSyntax(chunks.join('').trim());
      if (final) {
        // Quality-телеметрия: пустой ответ / англ-утечка / объём — для агрегатов
        // и алертов регрессии (инициатива «гарантия качества», беклог a867ef3b).
        this.events?.track('chat_quality', {
          userId, sessionId: `${userId}_${assistantId}`,
          props: {
            assistant_id: assistantId,
            ok: fullText.length > 0,
            empty: fullText.length === 0,
            chars: fullText.length,
            english_leak: this.looksEnglishLeak(fullText),
          },
        });
      }
      if (final && fullText.length === 0) {
        this.logger.warn(
          `empty stream for session ${userId}_${assistantId} — r.linkeon.io completed without delta events ` +
          `(clientDisconnected=${clientDisconnected})`,
        );
      }
      // If we have actual content — save it.
      // If empty on final: don't pollute history with a stub AI row; save user message + a brief retry-hint.
      // (Frontend will reload history; user can simply resend.)
      const aiText = fullText
        || (final ? '_Ответ не пришёл. Попробуйте отправить сообщение ещё раз._' : '');
      if (!aiText) return; // skip empty intermediate persists
      const textCost = fullText.length * this.SDK_TEXT_MULTIPLIER;
      try {
        const sessOverride = fresh ? freshSessionId : undefined;
        if (userMsgPersisted) {
          await this.saveAssistantMessageRow(userId, assistantId, aiText, textCost, sessOverride);
        } else {
          await this.saveChatHistory(userId, assistantId, message, aiText, textCost, sessOverride);
        }
        if (fullText.length > 0) {
          await this.addTokenTask(userId, 0, textCost, agentId);
          // Профиль формируется и в fresh-режиме (чистый лист скрывает контекст,
          // но не отключает обучение профиля).
          if (this.neo4j) {
            try { await this.neo4j.consolidateFromChat(userId, assistantId, message, fullText); } catch {}
          }
          // Задачи из fresh-разговора не извлекаем — чистый лист без побочных задач.
          if (this.tasksService && !fresh) {
            try { await this.tasksService.extractFromTurn(userId, assistantId, message, fullText); } catch {}
          }
        }
      } catch (e: any) {
        this.logger.warn(`persistResponse failed: ${e.message}`);
      }
    };

    try {
      // Один вызов upstream r.linkeon: парсит SSE, пушит в chunks и стримит
      // 'item' клиенту. Вынесено в замыкание ради self-heal ретрая пустого потока.
      const callUpstreamOnce = async (): Promise<void> => {
        const FormData = require('form-data');
        const fd = new FormData();
        fd.append('message', prompt);
        // fresh: relay (r.linkeon.io) держит СВОЮ память по sessionId и резюмит
        // Claude-сессию — обычный id протаскивал прошлый контекст (задачи,
        // разговоры) в «чистый лист» мимо наших блокировок. Fresh-сессия
        // получает на relay собственную чистую память.
        fd.append('sessionId', fresh && freshSessionId ? freshSessionId : `${userId}_${assistantId}`);

        const agentRes = await axios.post(`${AGENT_URL}/chat`, fd, {
          headers: fd.getHeaders(),
          responseType: 'stream',
          timeout: 600000, // 10 min
        });

        await new Promise<void>((resolve, reject) => {
          let buffer = '';
          agentRes.data.on('data', (chunk: Buffer) => {
            try {
              lastDataAt = Date.now();
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const ev = JSON.parse(line.slice(6));

                  if (ev.type === 'delta' || ev.type === 'text') {
                    chunks.push(ev.text);
                    safeWrite({ type: 'item', content: ev.text });
                  } else if (ev.type === 'result' && ev.text) {
                    if (chunks.length === 0) {
                      chunks.push(ev.text);
                      safeWrite({ type: 'item', content: ev.text });
                    }
                  } else if (ev.type === 'done') {
                    // Collect output files info if any
                    if (ev.outputFiles && ev.outputFiles.length > 0) {
                      const fileLinks = ev.outputFiles
                        .map((f: any) => `[Скачать ${f.name}](${AGENT_URL}${f.url})`)
                        .join('\n');
                      if (fileLinks && !chunks.join('').includes(AGENT_URL)) {
                        chunks.push('\n\n' + fileLinks);
                        safeWrite({ type: 'item', content: '\n\n' + fileLinks });
                      }
                    }
                  }
                } catch {}
              }
            } catch (e: any) {
              this.logger.warn(`data handler error (non-fatal): ${e.message}`);
            }
          });
          agentRes.data.on('end', () => resolve());
          agentRes.data.on('error', (err: Error) => reject(err));
        });
      };

      await callUpstreamOnce();

      // SELF-HEAL: r.linkeon иногда отдаёт ПУСТОЙ поток (0 delta-событий, ~сотни
      // мс) — корень жалоб «постоянно выдаёт ошибку». Если ничего не пришло и
      // клиент ещё на связи — тихо повторяем upstream ОДИН раз, прежде чем отдать
      // юзеру пустоту. Безопасно: при пустом chunks клиенту ещё не ушло ни одного
      // 'item' (дублей не будет). Инцидент/находка 2026-07-12.
      if (chunks.length === 0 && !clientDisconnected) {
        this.logger.warn(`empty stream from r.linkeon for ${userId}_${assistantId} — self-heal retry`);
        this.events?.track('chat_quality', {
          userId, sessionId: `${userId}_${assistantId}`,
          props: { assistant_id: assistantId, self_heal_retry: true },
        });
        await new Promise((r) => setTimeout(r, 800));
        try { await callUpstreamOnce(); } catch (e: any) { this.logger.warn(`self-heal retry failed: ${e.message}`); }
      }

      // Strip any [VIDEO_JOB:<uuid>] markers Roman may have hallucinated.
      // We re-inject only verified jobs from DB query below.
      for (let i = 0; i < chunks.length; i++) {
        chunks[i] = chunks[i].replace(/\s*\[VIDEO_JOB:[0-9a-f-]{36}\]\s*/gi, '');
        chunks[i] = chunks[i].replace(/\s*\[CALENDAR_PROPOSAL:[0-9a-f-]{36}\]\s*/gi, '');
      }

      // Detect video jobs created during this stream by querying recent jobs.
      // Roman's MCP-bridge tool calls don't surface structural tool_result events,
      // so we tag the stream with [VIDEO_JOB:<uuid>] markers for the frontend to
      // attach inline players. Border = streamStartTime, scoped to this user.
      try {
        const startTimeIso = new Date(streamStartTime).toISOString();
        const jobsRes = await this.pg.query(
          `SELECT id FROM video_jobs
           WHERE user_id = $1 AND created_at >= $2::timestamptz
           ORDER BY created_at ASC`,
          [userId, startTimeIso],
        );
        if (jobsRes.rows.length > 0) {
          const markers = jobsRes.rows.map((r: any) => `[VIDEO_JOB:${r.id}]`).join('\n');
          const tail = '\n\n' + markers;
          chunks.push(tail);
          safeWrite({ type: 'item', content: tail });
        }
      } catch (e: any) {
        this.logger.warn(`video marker injection failed: ${e.message}`);
      }

      // Detect calendar proposals created during this stream, same mechanism as
      // video jobs above: the MCP-bridge (agent) path used by real agents doesn't
      // emit structural tool_result events, so propose_calendar_event persists to
      // calendar_proposals and we tag the stream with [CALENDAR_PROPOSAL:<uuid>]
      // markers for the frontend to render the T6 card. Border = streamStartTime,
      // scoped to this user.
      try {
        const startTimeIso = new Date(streamStartTime).toISOString();
        const propRes = await this.pg.query(
          `SELECT id FROM calendar_proposals WHERE user_id = $1 AND created_at >= $2::timestamptz ORDER BY created_at ASC`,
          [userId, startTimeIso],
        );
        if (propRes.rows.length > 0) {
          const markers = propRes.rows.map((r: any) => `[CALENDAR_PROPOSAL:${r.id}]`).join('\n');
          const tail = '\n\n' + markers;
          chunks.push(tail);
          safeWrite({ type: 'item', content: tail });
        }
      } catch (e: any) {
        this.logger.warn(`calendar marker injection failed: ${e.message}`);
      }

      const fullText = chunks.join('');
      // Text cost: длина ответа × SDK-множитель. Картинки/видео списываются
      // их MCP-сервисами отдельно (см. toolSpent ниже).
      const tokensUsed = fullText.length * this.SDK_TEXT_MULTIPLIER;

      // Sum up tool-charged tokens (image, video, etc.) during this stream.
      // MCP-tools (MiscService.generateImage, VideoService.createJob) deduct
      // directly from ai_profiles_consolidated and write rows into
      // generated_images / video_jobs with tokens_spent. Aggregate from there.
      let toolSpent = 0;
      try {
        const startIso = new Date(streamStartTime).toISOString();
        const r = await this.pg.query(
          `SELECT
             COALESCE((SELECT SUM(tokens_spent) FROM generated_images WHERE user_id = $1 AND created_at >= $2::timestamptz), 0)::bigint
             +
             COALESCE((SELECT SUM(tokens_spent) FROM video_jobs WHERE user_id = $1 AND created_at >= $2::timestamptz), 0)::bigint
             AS spent`,
          [userId, startIso],
        );
        toolSpent = Number(r.rows[0]?.spent ?? 0);
      } catch (e: any) {
        this.logger.warn(`tool spend query failed: ${e.message}`);
      }

      const displayedTotal = tokensUsed + toolSpent;

      safeWrite({
        type: 'end',
        content: fullText,
        usage: { input: 0, output: displayedTotal, total: displayedTotal },
      });
      if (!clientDisconnected) {
        try { res.end(); } catch {}
      }

      // Async persist — dedup via `saved` flag with the catch-path persist.
      setImmediate(() => { void persistResponse(true); });
    } catch (err) {
      this.logger.error(`Universal agent proxy error: ${err.message}`);
      // Try to write error to response; safeWrite is a no-op if client gone.
      const errText = 'Ошибка запуска агента. Попробуйте ещё раз.';
      safeWrite({ type: 'item', content: errText });
      safeWrite({ type: 'end', content: errText, usage: { input: 0, output: 0, total: 0 } });
      if (!clientDisconnected) {
        try { res.end(); } catch {}
      }
      // Async persist — preserves user message + partial response.
      setImmediate(() => { void persistResponse(true); });
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Убирает утёкший в текст tool-call синтаксис — глитч деградации модели на
   * сверхдлинном контексте (инцидент 2026-07-10, сессия Романа): модель пишет
   * <invoke>/<parameter>-блоки и строки-артефакты «court» текстом вместо
   * реальных tool_use. Не трогает markdown-картинки ![](url) — так юзеру
   * показываются MCP-изображения в universal-agent-пути.
   */
  private stripLeakedToolSyntax(text: string): string {
    if (!text) return text;
    return text
      .replace(/<invoke name="[^"]*">[\s\S]*?<\/invoke>/g, '')
      .replace(/<invoke name="[^"]*">[\s\S]*$/g, '')
      .replace(/<\/?(?:invoke|parameter|function_calls)\b[^>]*>/g, '')
      .replace(/(^|\n)court(?=\n|$)/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private stripToolTags(text: string): string {
    return text
      .replace(/<\/?function_calls>/g, '')
      .replace(/<\/?get_metaphor_card>/g, '')
      .replace(/<\/?get_profile>/g, '')
      .replace(/<\/?tool_call>/g, '')
      .replace(/<\/?tool_result>/g, '')
      .replace(/<\/?invoke\b[^>]*>/g, '')
      .replace(/<\/?parameter\b[^>]*>/g, '')
      .replace(/<\/?antml:[^>]*>/g, '')
      .replace(/\[?\s*\{\s*"tool_name"\s*:\s*"[^"]*"\s*,\s*"arguments"\s*:\s*\{[^}]*\}\s*\}\s*\]?/g, '')
      // Remove fake/empty/placeholder markdown images
      .replace(/!\[[^\]]*\]\(\{?image_url\}?\)/g, '')
      .replace(/!\[[^\]]*\]\(https?:\/\/images\.linkeon\.io[^)]*\)/g, '')
      .replace(/!\[\]\([^)]*\)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private async getRandomMetaphorCard(userId: string): Promise<string | null> {
    // Ensure active session exists
    const sessionRes = await this.pg.query(
      `SELECT id, cards_shown FROM game_sessions WHERE user_id = $1 AND session_state = 'active' ORDER BY started_at DESC LIMIT 1`,
      [userId],
    );
    let cardsShown: number[] = [];
    if (sessionRes.rows.length === 0) {
      await this.pg.query(
        `INSERT INTO game_sessions (user_id, session_type, session_state, cards_shown, started_at, last_activity) VALUES ($1, 'metaphor', 'active', '[]'::jsonb, now(), now())`,
        [userId],
      );
    } else {
      cardsShown = (sessionRes.rows[0].cards_shown || []).map(Number);
    }

    // Pick random card not yet shown
    const cardRes = await this.pg.query(
      `SELECT id, image_url FROM metaphor_cards WHERE id != ALL($1::int[]) ORDER BY RANDOM() LIMIT 1`,
      [cardsShown],
    );
    if (!cardRes.rows.length) {
      // All cards shown — reset session
      await this.pg.query(
        `UPDATE game_sessions SET cards_shown = '[]'::jsonb, last_activity = now() WHERE user_id = $1 AND session_state = 'active'`,
        [userId],
      );
      const resetRes = await this.pg.query(`SELECT id, image_url FROM metaphor_cards ORDER BY RANDOM() LIMIT 1`);
      if (!resetRes.rows.length) return null;
      return resetRes.rows[0].image_url;
    }

    const card = cardRes.rows[0];
    // Update session
    await this.pg.query(
      `UPDATE game_sessions SET cards_shown = cards_shown || $1::jsonb, last_activity = now() WHERE user_id = $2 AND session_state = 'active'`,
      [JSON.stringify([card.id]), userId],
    );

    return card.image_url;
  }

  async saveChatHistoryPublic(userId: string, agentId: string, userMsg: string, assistantMsg: string, tokensUsed = 0) {
    return this.saveChatHistory(userId, agentId, userMsg, assistantMsg, tokensUsed);
  }

  /**
   * Публичная НЕ-стримовая генерация ответа ассистента — для проактивных
   * рутинных пушей (Слой 3, RoutinePushService). Собирает персона-префикс +
   * профиль пользователя + сообщение, прогоняет через r.linkeon.io и возвращает
   * готовый текст. Историю/токены НЕ пишет (это делает вызывающий). Пустой
   * ответ → пустая строка.
   */
  async generateAgentReply(userId: string, assistantId: string, message: string, sessionIdOverride?: string): Promise<string> {
    const isNumeric = /^\d+$/.test(assistantId);
    const agentRes = isNumeric
      ? await this.pg.query('SELECT * FROM agents WHERE id = $1 LIMIT 1', [parseInt(assistantId, 10)])
      : await this.pg.query('SELECT * FROM agents WHERE name = $1 LIMIT 1', [assistantId]);
    const agent = agentRes.rows[0];
    if (!agent) throw new Error(`generateAgentReply: agent not found: ${assistantId}`);
    const agentName = agent.display_name || agent.name;

    let profileText = '';
    if (this.neo4j) { try { profileText = await this.neo4j.getProfileDescription(userId); } catch {} }

    let prefix =
      `СИСТЕМНАЯ ИНСТРУКЦИЯ (имеет приоритет над всеми остальными). ` +
      `Ты ассистент по имени **${agentName}**${agent.description ? ` — ${agent.description}` : ''} на платформе LINKEON.IO. ` +
      `Всегда представляйся именно как ${agentName}. Никогда не упоминай, что ты Claude или другая AI-система помимо ${agentName}. ` +
      `ЯЗЫК ОТВЕТА: всегда на русском языке.\n\n`;
    if (agent.system_prompt && agent.system_prompt.trim()) {
      prefix += `--- Персона и инструкции ассистента ${agentName} ---\n${agent.system_prompt.trim()}\n\n`;
    }
    if (profileText && profileText.trim()) {
      prefix += `User profile:\n${profileText}\n\n`;
    }
    const prompt = prefix + message;

    const AGENT_URL = process.env.AGENT_URL || 'https://r.linkeon.io';
    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('message', prompt);
    // sessionIdOverride — для синтетических проб: изолированная сессия, чтобы не
    // коллидить с реальной сессией юзера/другими пробами (r.linkeon отдаёт пустой
    // поток при конкурентном обращении к ЗАНЯТОЙ сессии — инцидент 2026-07-12).
    fd.append('sessionId', sessionIdOverride || `${userId}_${assistantId}`);
    const chunks: string[] = [];
    const resp = await axios.post(`${AGENT_URL}/chat`, fd, {
      headers: fd.getHeaders(),
      responseType: 'stream',
      timeout: 300000,
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      resp.data.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'delta' || ev.type === 'text') chunks.push(ev.text);
            else if (ev.type === 'result' && ev.text && chunks.length === 0) chunks.push(ev.text);
          } catch {}
        }
      });
      resp.data.on('end', () => resolve());
      resp.data.on('error', reject);
    });
    return this.stripToolTags(chunks.join('')).trim();
  }

  /** Public wrapper для chat.controller — после upload-and-chat обогащаем профиль + tasks. */
  async consolidateAfterChatPublic(userId: string, agentId: string, userMessage: string, assistantResponse: string): Promise<void> {
    if (this.neo4j) {
      try { await this.neo4j.consolidateFromChat(userId, agentId, userMessage, assistantResponse); } catch (e: any) {
        this.logger.warn(`consolidateAfterChatPublic neo4j failed: ${e?.message}`);
      }
    }
    if (this.tasksService) {
      try { await this.tasksService.extractFromTurn(userId, agentId, userMessage, assistantResponse); } catch {}
    }
  }

  private async saveChatHistory(userId: string, agentId: string, userMsg: string, assistantMsg: string, tokensUsed = 0, sessionIdOverride?: string) {
    await this.saveUserMessageRow(userId, agentId, userMsg, sessionIdOverride);
    await this.saveAssistantMessageRow(userId, agentId, assistantMsg, tokensUsed, sessionIdOverride);
  }

  private async saveUserMessageRow(userId: string, agentId: string, userMsg: string, sessionIdOverride?: string) {
    const sessionId = sessionIdOverride || `${userId}_${agentId}`;
    const agentNum = /^\d+$/.test(agentId) ? parseInt(agentId, 10) : null;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'human', $2, $3, 'text')`,
      [sessionId, agentNum, userMsg],
    );
  }

  private async saveAssistantMessageRow(userId: string, agentId: string, assistantMsg: string, tokensUsed = 0, sessionIdOverride?: string) {
    const sessionId = sessionIdOverride || `${userId}_${agentId}`;
    const agentNum = /^\d+$/.test(agentId) ? parseInt(agentId, 10) : null;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
       VALUES ($1, 'ai', $2, $3, 'text', $4)`,
      [sessionId, agentNum, assistantMsg, tokensUsed],
    );
  }

  private async addTokenTask(userId: string, inputTokens: number, outputTokens: number, agentId?: string) {
    const executionId = Math.floor(Math.random() * 2000000000);
    const agentIdNum = agentId && /^\d+$/.test(agentId) ? parseInt(agentId, 10) : null;
    await this.pg.query(
      `INSERT INTO token_consumption_tasks (execution_id, user_id, status, agent_id, input_tokens, output_tokens, tokens_to_consume)
       VALUES ($1, $2, 'pending', $3, $4, $5, 0)`,
      [executionId, userId, agentIdNum, inputTokens, outputTokens],
    );
  }

  async getChatHistory(userId: string, assistantId: string, limit = 30, offset = 0, sessionIdOverride?: string): Promise<{ messages: any[]; hasMore: boolean }> {
    const sessionId = sessionIdOverride || `${userId}_${assistantId}`;
    const res = await this.pg.query(
      `SELECT id, sender_type, content, created_at, tokens_used FROM custom_chat_history
       WHERE session_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [sessionId, limit + 1, offset],
    );
    const hasMore = res.rows.length > limit;
    const rows = hasMore ? res.rows.slice(0, limit) : res.rows;
    const messages = rows.reverse().map(r => ({
      id: String(r.id),
      type: r.sender_type === 'human' ? 'user' : 'assistant',
      content: r.content,
      timestamp: r.created_at,
      tokensUsed: r.tokens_used || 0,
    }));
    return { messages, hasMore };
  }

  async deleteChatHistory(userId: string, assistantId: string) {
    const sessionId = `${userId}_${assistantId}`;
    await this.pg.query(
      'DELETE FROM custom_chat_history WHERE session_id = $1',
      [sessionId],
    );
    return { success: true };
  }


}
