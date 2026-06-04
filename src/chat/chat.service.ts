import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { KlingService } from '../misc/kling.service';
import { ChatToolsService, CHAT_TOOLS } from './chat-tools';
import { SmmProducerToolsService } from '../smm/producer/smm-producer-tools.service';
import { ClaudeAgentService } from './claude-agent.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../events/events.service';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { Request, Response } from 'express';
// Agent server at r.linkeon.io (remote Claude Code)

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  // Множитель цены за текст для агентов, идущих через SDK-путь
  // (streamUniversalAgent → r.linkeon.io). Применяется только для текстовых
  // токенов; MCP-инструменты (картинки, видео) списываются их сервисами
  // независимо и НЕ умножаются здесь. Не касается Маши (id=3, локальный
  // ClaudeCliService — OAuth subscription, без отдельного API-биллинга).
  private readonly SDK_TEXT_MULTIPLIER = 2;
  private anthropic: Anthropic | null = null;

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
  ) {
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    }
  }

  async streamChat(
    userId: string,
    message: string,
    assistantId: string,
    sessionId: string,
    profileText: string,
    res: Response,
    req?: Request,
  ): Promise<void> {
    // Get agent
    const isNumeric = /^\d+$/.test(assistantId);
    const agentRes = isNumeric
      ? await this.pg.query('SELECT * FROM agents WHERE id = $1 LIMIT 1', [parseInt(assistantId, 10)])
      : await this.pg.query('SELECT * FROM agents WHERE name = $1 LIMIT 1', [assistantId]);
    const agent = agentRes.rows[0];
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    this.events?.track('message_sent', {
      userId,
      sessionId,
      props: { assistant_id: String(agent.id), assistant_name: agent.name, length: message?.length || 0 },
    });

    // Get chat history (individual rows: session_id, sender_type, content)
    const chatSessionId = `${userId}_${assistantId}`;
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

    // Route ALL agents except Маша (id=3) via streamUniversalAgent →
    // r.linkeon.io with MCP tools (image/video/code execution).
    // Cheaper, unified, MCP delivers Nano Banana + Kling natively.
    // Маша runs locally via ClaudeCliService (OAuth subscription, no per-
    // call billing) because her flow is metaphor-card driven, not tool-
    // heavy; the card pull happens in post-processing below.
    if (agent.id !== 3) {
      return this.streamUniversalAgent(
        userId, message, String(assistantId), String(agent.id),
        recentHistory, profileText, res,
        agent.name, agent.description || '', agent.system_prompt || '',
        req,
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
    if (this.tasksService) {
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
          try { await this.saveChatHistory(userId, String(assistantId), message, greetText); } catch {}
          // No token deduction for greeting
        });
        return;
      } catch (e) {
        this.logger.error(`DeepSeek greeting error: ${e.message}`);
        // Fall through to Anthropic
      }
    }

    // Маша runs via Claude CLI (OAuth subscription) — no separate API-key
    // billing, no streaming, no tool use. The CHAT_TOOLS loop and the
    // Anthropic-SDK streaming path were removed because Маша's value is
    // the metaphor-card flow (handled by post-processing below), not
    // image/video generation. If we need to bring tools back for her,
    // route through streamUniversalAgent like every other assistant.
    const isМаша = agent.name === 'Маша';
    res.write(JSON.stringify({ type: 'begin' }) + '\n');

    const chunks: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      // Compose a single one-shot prompt: system + recent history + current user message.
      // ClaudeCliService passes everything in one prompt — no separate messages array.
      const historyText = recentHistory
        .map((m) => `${m.type === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`)
        .join('\n\n');
      const promptForCli = [
        historyText ? `Предыдущий контекст диалога:\n${historyText}\n\n---\n\n` : '',
        `Сообщение пользователя:\n${message}`,
      ].join('');

      const { text, costUsd } = await this.claudeCli.textWithCost(promptForCli, {
        system: systemPrompt,
        model: 'claude-haiku-4-5',
        timeoutMs: 60_000,
      });
      this.logger.log(`chat[${agent.name}] via Claude CLI: $${costUsd.toFixed(4)}, ${text.length} chars`);
      chunks.push(text);
      // Buffer behaviour: hold the text until we've done card-detection
      // post-processing (item line is emitted at the end of this method).
    } catch (e: any) {
      this.logger.error(`Claude CLI error for ${agent.name}: ${e.message}`);
      chunks.push('Ошибка соединения с ассистентом.');
    }
    // Clean and post-process the full response
    const rawFull = chunks.join('');
    let fullText = this.stripToolTags(rawFull);

    // If Маша tried to show a metaphor card, fetch a real one
    // Detect metaphor card: tool tags, fake URLs, or Маша talking about showing a card
    const cardPattern = /(?:get_metaphor_card|images\.linkeon\.io|image_url|вот.*карт|первая карта|следующая карта|покажу.*карт|новая карта|вытяни.*карт|твоя карта|вот она|карту для тебя|достаю карту|тяну карту|открываю карту|Что ты видишь на этой карте|Какие чувства.*вызывает)/i;
    const cardMatch = cardPattern.test(rawFull) || (isМаша && /карт/i.test(rawFull));
    this.logger.log(`Card check: agent=${agent.name}, isМаша=${isМаша}, match=${cardMatch}, rawLen=${rawFull.length}`);
    if (cardMatch) {
      try {
        const cardUrl = await this.getRandomMetaphorCard(userId);
        if (cardUrl) {
          fullText = `${fullText.trim()}\n\n![Метафорическая карта](${cardUrl})`;
        }
      } catch (e) {
        this.logger.error(`Metaphor card error: ${e.message}`);
      }
    }

    const tokensUsed = inputTokens + outputTokens;
    // This path is Маша-only and the Claude CLI returns a single block, so
    // we always emit the final text as one `item` line right before `end`.
    res.write(JSON.stringify({ type: 'item', content: fullText }) + '\n');
    res.write(JSON.stringify({ type: 'end', content: fullText, usage: { input: inputTokens, output: outputTokens, total: tokensUsed } }) + '\n');
    res.end();

    // Async: save to DB and consolidate profile after response sent
    setImmediate(async () => {
      try {
        const tokensUsed = inputTokens + outputTokens;
        await this.saveChatHistory(userId, String(assistantId), message, fullText, tokensUsed);
        await this.addTokenTask(userId, inputTokens, outputTokens, String(agent.id));
        // Extract profile entities from conversation
        if (this.neo4j) {
          await this.neo4j.consolidateFromChat(userId, String(assistantId), message, fullText);
        }
        // Operational task memory (cross-agent)
        if (this.tasksService) {
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
  ): Promise<void> {
    const AGENT_URL = process.env.AGENT_URL || 'https://r.linkeon.io';

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
    // незаконченных дел, а не отвечающих с нуля.
    if (this.tasksService) {
      try {
        const tasksCtx = await this.tasksService.buildContextForPrompt(userId, message);
        if (tasksCtx) contextPrefix += tasksCtx + '\n';
      } catch (e: any) {
        this.logger.warn(`tasks context injection failed: ${e?.message}`);
      }
    }
    if (recentHistory.length > 0) {
      const historyLines = recentHistory
        .slice(-6)
        .map(m => `${m.type === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
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

    // Guard against the upstream (r.linkeon.io / Claude subscription) leaking a
    // raw "You've hit your session limit · resets …" notice as if it were the
    // assistant's reply. Detect it, replace with a graceful message, and
    // suppress any further chunks for this turn.
    let limitHit = false;
    const LIMIT_RE = /(hit your (?:session|usage) limit|(?:session|usage) limit\b[^.\n]*reset|rate limit)/i;
    const forwardItem = (text: string) => {
      if (limitHit) return;
      if (LIMIT_RE.test(text)) {
        limitHit = true;
        const friendly = 'Извините, сервис ассистентов сейчас перегружен и временно недоступен — попробуйте, пожалуйста, через несколько минут. 🙏';
        chunks.length = 0;
        chunks.push(friendly);
        safeWrite({ type: 'item', content: friendly });
        return;
      }
      chunks.push(text);
      safeWrite({ type: 'item', content: text });
    };

    // Single persistence point — dedupe via `saved` flag so success and error paths
    // both call but only one actually writes.
    let saved = false;
    const persistResponse = async (final: boolean) => {
      if (saved) return;
      saved = true;
      const fullText = chunks.join('').trim();
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
        await this.saveChatHistory(userId, assistantId, message, aiText, textCost);
        if (fullText.length > 0 && !limitHit) {
          await this.addTokenTask(userId, 0, textCost, agentId);
          if (this.neo4j) {
            try { await this.neo4j.consolidateFromChat(userId, assistantId, message, fullText); } catch {}
          }
          if (this.tasksService) {
            try { await this.tasksService.extractFromTurn(userId, assistantId, message, fullText); } catch {}
          }
        }
      } catch (e: any) {
        this.logger.warn(`persistResponse failed: ${e.message}`);
      }
    };

    try {
      // Build multipart form
      const FormData = require('form-data');
      const fd = new FormData();
      fd.append('message', prompt);
      // sessionId namespace version. r.linkeon.io's Claude Code caches the MCP
      // tool list per session for the session's lifetime, so adding a new tool
      // (Veo to generate_video) is invisible to already-warm sessions — they
      // keep rejecting veo-3.1-* as an unknown enum value. Bumping this suffix
      // forces fresh sessions that re-fetch tools/list (now including Veo).
      // Continuity is preserved: persona + last-6-message history are re-injected
      // into every prompt above, so r.linkeon.io-side memory is non-critical.
      // BUMP THIS when MCP tool schemas change and must reach live sessions.
      fd.append('sessionId', `${userId}_${assistantId}_v3`);

      const agentRes = await axios.post(`${AGENT_URL}/chat`, fd, {
        headers: fd.getHeaders(),
        responseType: 'stream',
        timeout: 600000, // 10 min
      });
      let inputTokens = 0;
      let outputTokens = 0;

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
                  forwardItem(ev.text);
                } else if (ev.type === 'result' && ev.text) {
                  if (chunks.length === 0) {
                    forwardItem(ev.text);
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

      // Strip any [VIDEO_JOB:<uuid>] markers Roman may have hallucinated.
      // We re-inject only verified jobs from DB query below.
      for (let i = 0; i < chunks.length; i++) {
        chunks[i] = chunks[i].replace(/\s*\[VIDEO_JOB:[0-9a-f-]{36}\]\s*/gi, '');
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
             AND status <> 'failed'
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

  private stripToolTags(text: string): string {
    return text
      .replace(/<\/?function_calls>/g, '')
      .replace(/<\/?get_metaphor_card>/g, '')
      .replace(/<\/?get_profile>/g, '')
      .replace(/<\/?tool_call>/g, '')
      .replace(/<\/?tool_result>/g, '')
      .replace(/<\/?invoke>/g, '')
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

  private async saveChatHistory(userId: string, agentId: string, userMsg: string, assistantMsg: string, tokensUsed = 0) {
    const sessionId = `${userId}_${agentId}`;
    const agentNum = /^\d+$/.test(agentId) ? parseInt(agentId, 10) : null;

    // Insert user message
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'human', $2, $3, 'text')`,
      [sessionId, agentNum, userMsg],
    );

    // Insert assistant message with tokens_used
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
       VALUES ($1, 'ai', $2, $3, 'text', $4)`,
      [sessionId, agentNum, assistantMsg, tokensUsed],
    );

    // Telemetry: one event per finished user↔assistant exchange. Feeds the
    // VPM snapshot (active_users_7d, chat_calls_7d) and the product metrics
    // funnel/economy/quality views. Fire-and-forget — EventsService buffers
    // and flushes asynchronously.
    this.events?.track('chat_message_sent', {
      userId,
      props: {
        assistant_id: agentId,
        tokens_used: tokensUsed,
        user_msg_len: userMsg.length,
        assistant_msg_len: assistantMsg.length,
      },
      source: 'chat.saveChatHistory',
    });
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

  async getChatHistory(userId: string, assistantId: string, limit = 30, offset = 0): Promise<{ messages: any[]; hasMore: boolean }> {
    const sessionId = `${userId}_${assistantId}`;
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

  private async streamToolLoopViaOpenRouter(
    userId: string,
    systemPrompt: string,
    llmMessages: { role: 'user' | 'assistant'; content: string }[],
    chunks: string[],
    needsBuffering: boolean,
    res: Response,
  ): Promise<{ inputTokens: number; outputTokens: number }> {
    const openaiTools = CHAT_TOOLS.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: (t as any).input_schema },
    }));
    const messages: any[] = [{ role: 'system', content: systemPrompt }, ...llmMessages];
    let inputTokens = 0, outputTokens = 0;

    for (let iter = 0; iter < 5; iter++) {
      const resp = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model: 'anthropic/claude-haiku-4.5', messages, tools: openaiTools, tool_choice: 'auto' },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://my.linkeon.io',
          },
          timeout: 60000,
        },
      );
      const choice = resp.data.choices[0];
      inputTokens += resp.data.usage?.prompt_tokens || 0;
      outputTokens += resp.data.usage?.completion_tokens || 0;
      const assistantMsg = choice.message;
      if (assistantMsg.content) {
        chunks.push(assistantMsg.content);
        if (!needsBuffering) res.write(JSON.stringify({ type: 'item', content: assistantMsg.content }) + '\n');
      }
      messages.push(assistantMsg);
      if (choice.finish_reason !== 'tool_calls' || !assistantMsg.tool_calls?.length) break;
      const toolResultMsgs: any[] = [];
      for (const tc of assistantMsg.tool_calls) {
        const name = tc.function.name;
        const input = JSON.parse(tc.function.arguments || '{}');
        res.write(JSON.stringify({ type: 'tool_start', tool: name, input }) + '\n');
        const result = await this.tools.executeTool(userId, name, input);
        res.write(JSON.stringify({ type: 'tool_result', tool: name, result }) + '\n');
        if (result.ok && (result as any).kind === 'image') {
          const md = `\n\n![Сгенерированное изображение](${(result as any).imageUrl})`;
          chunks.push(md);
          if (!needsBuffering) res.write(JSON.stringify({ type: 'item', content: md }) + '\n');
        }
        toolResultMsgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      messages.push(...toolResultMsgs);
    }
    return { inputTokens, outputTokens };
  }

}
