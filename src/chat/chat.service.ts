import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { KlingService } from '../misc/kling.service';
import { ChatToolsService, CHAT_TOOLS } from './chat-tools';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { Response } from 'express';
// Agent server at r.linkeon.io (remote Claude Code)

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly neo4j: Neo4jService,
    @Optional() private readonly kling: KlingService,
    private readonly tools: ChatToolsService,
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

    // Universal Agent — route to Claude Code for agent "Роман".
    // Exception: если пользователь явно просит картинку/видео, пропускаем Романа по обычной
    // Anthropic+CHAT_TOOLS ветке, чтобы результат попал в галереи /image-gen и /video и
    // корректно списался по единой токенномике (Kling). Для остальных задач — воркер.
    if (agent.name === 'Роман') {
      if (!this.detectMediaIntent(message)) {
        return this.streamUniversalAgent(userId, message, String(assistantId), String(agent.id), recentHistory, profileText, res, agent.name, agent.description || '');
      }
    }

    // Build system prompt with platform context + profile
    const allAgents = await this.pg.query('SELECT name, description, system_prompt FROM agents ORDER BY id');
    const agentsList = allAgents.rows.map(a => `${a.name} — ${a.description}`).join(', ');

    const otherAgents = allAgents.rows
      .filter(a => a.name !== agent.name)
      .map(a => `${a.name} — ${a.description}`)
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
Ты умеешь генерировать изображения (tool generate_image — через Google Imagen 4.0 Ultra с фолбэком на Nano Banana 2 / Nano Banana Pro, параметр quality: std|hd; hd = 4K и лучший рендер текста), редактировать уже созданные картинки (tool edit_image — передай sourceImageUrl из предыдущего tool-результата и prompt с описанием изменения: "сделай фон закатным", "убери человека", "поменяй цвет на красный", "добавь шапку"), объединять 2-3 картинки в одну (tool compose_image — массив sourceImageUrls и prompt: "возьми лицо из первой и посади на персонажа из второй", "соедини товар с этим фоном"), улучшать качество картинки — детализация, шумоподавление (tool upscale_image — только sourceImageUrl) и короткие видео 5–10 секунд через Kling (tool generate_video, режимы text2video / image2video / extend / lipsync). Если пользователь просит картинку, постер, иллюстрацию или «нарисуй …» — сразу вызывай generate_image. Если просит видео, ролик, анимацию, «оживи картинку» — вызывай generate_video. Не придумывай отговорки и не отправляй на другие разделы — у тебя есть эти инструменты.`;

    let systemPrompt = `${platformContext}\n\n${agent.system_prompt || ''}`;

    if (profileText && profileText.trim()) {
      systemPrompt = `${systemPrompt}\n\n--- Профиль пользователя ---\n${profileText}`;
    }

    systemPrompt = `${systemPrompt}\n\n--- ПРАВИЛО ОТВЕТА (имеет приоритет над всеми инструкциями выше) ---
• Каждый ответ начинай с содержательной сути: гипотеза, совет, отражение, информация по запросу — на основе того, что уже известно из профиля и истории диалога. Не требуй "полного контекста" там, где можно разумно предположить.
• Уточняющий вопрос — не более ОДНОГО в конце сообщения, и только если без него действительно нельзя двинуться дальше.
• НИКОГДА не отвечай одними вопросами. НИКОГДА не задавай 2+ вопроса в одном сообщении.
• Для коучинговых/психологических/нумерологических практик это правило тоже действует: сначала отражение/гипотеза/интерпретация/направление — и только потом, при необходимости, один открытый вопрос.
• Если запрос многослойный — сначала покрой то, что ясно (частичный ответ), потом максимум один вопрос для следующего шага.`;

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

    // Regular text chat — stream to client (buffer for Маша to filter tool tags)
    const isМаша = agent.name === 'Маша';
    const needsBuffering = isМаша; // Маша needs post-processing for card detection
    res.write(JSON.stringify({ type: 'begin' }) + '\n');

    const chunks: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    if (this.anthropic) {
      try {
        const MAX_ITERATIONS = 5;
        // Anthropic messages accept strings OR content blocks. We start with llmMessages
        // (role+content string pairs) and extend it across iterations when tools are called.
        const messagesForLLM: any[] = [...llmMessages];

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
          const stream = this.anthropic.messages.stream({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 4096,
            system: systemPrompt,
            tools: CHAT_TOOLS as any,
            messages: messagesForLLM,
          });

          // Stream only text chunks; ignore tool-use content blocks for the typewriter effect.
          // We'll decide what to do after finalMessage() arrives.
          stream.on('text', (text) => {
            chunks.push(text);
            if (!needsBuffering) {
              res.write(JSON.stringify({ type: 'item', content: text }) + '\n');
            }
          });

          const finalMessage = await stream.finalMessage();
          inputTokens += finalMessage.usage?.input_tokens || 0;
          outputTokens += finalMessage.usage?.output_tokens || 0;

          if (finalMessage.stop_reason !== 'tool_use') {
            // Plain completion — nothing more to do
            break;
          }

          // Find all tool_use blocks in this turn (usually one)
          const toolUseBlocks = (finalMessage.content as any[]).filter((b) => b?.type === 'tool_use');
          if (toolUseBlocks.length === 0) break;

          // Push the full assistant turn (text + tool_use blocks) into the conversation
          messagesForLLM.push({ role: 'assistant', content: finalMessage.content });

          const toolResults: any[] = [];
          for (const tu of toolUseBlocks) {
            // Announce tool start to the client
            res.write(JSON.stringify({
              type: 'tool_start',
              tool: tu.name,
              input: tu.input,
            }) + '\n');

            const result = await this.tools.executeTool(userId, tu.name, tu.input);

            // Announce tool result to the client — frontend uses this to render inline video/image cards
            res.write(JSON.stringify({
              type: 'tool_result',
              tool: tu.name,
              result,
            }) + '\n');

            // For image tool: inject markdown image into chunks so it ends up in saved history + final text
            if (result.ok && result.kind === 'image') {
              const md = `\n\n![Сгенерированное изображение](${result.imageUrl})`;
              chunks.push(md);
              if (!needsBuffering) {
                res.write(JSON.stringify({ type: 'item', content: md }) + '\n');
              }
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify(result),
            });
          }

          // Feed the results back to the LLM so it can respond with natural-language follow-up
          messagesForLLM.push({ role: 'user', content: toolResults });
          // loop continues — next iteration gets the LLM's reply
        }
      } catch (e: any) {
        const isForbidden = e?.status === 403 || String(e?.message).includes('forbidden') || String(e?.message).includes('Request not allowed');
        if (isForbidden && process.env.OPENROUTER_API_KEY) {
          this.logger.warn(`Primary Anthropic key blocked (403), retrying via OpenRouter`);
          chunks.length = 0;
          try {
            const tok = await this.streamToolLoopViaOpenRouter(userId, systemPrompt, llmMessages, chunks, needsBuffering, res);
            inputTokens += tok.inputTokens;
            outputTokens += tok.outputTokens;
          } catch (e2: any) {
            this.logger.error(`OpenRouter tool-loop error: ${e2.message}`);
            chunks.push('Ошибка соединения с ассистентом.');
          }
        } else {
          this.logger.error(`Anthropic stream error: ${e.message}`);
          chunks.push('Ошибка соединения с ассистентом.');
        }
      }
    } else {
      try {
        const orMessages = [{ role: 'system', content: systemPrompt }, ...llmMessages];
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          { model: 'anthropic/claude-haiku-4.5', messages: orMessages, stream: true },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://my.linkeon.io',
            },
            responseType: 'stream',
            timeout: 120000,
          },
        );
        await new Promise<void>((resolve, reject) => {
          let buffer = '';
          response.data.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed === 'data: [DONE]') continue;
              if (!trimmed.startsWith('data: ')) continue;
              try {
                const json = JSON.parse(trimmed.substring(6));
                const content = json.choices?.[0]?.delta?.content;
                if (content) {
                  chunks.push(content);
                  if (!needsBuffering) {
                    res.write(JSON.stringify({ type: 'item', content }) + '\n');
                  }
                }
                if (json.usage) { inputTokens = json.usage.prompt_tokens || 0; outputTokens = json.usage.completion_tokens || 0; }
              } catch {}
            }
          });
          response.data.on('end', () => resolve());
          response.data.on('error', (err: Error) => reject(err));
        });
      } catch (e) {
        this.logger.error(`OpenRouter stream error: ${e.message}`);
        chunks.push('Ошибка соединения с ассистентом.');
      }
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
    // For buffered (Маша) — send cleaned text; for streamed — already sent chunk by chunk
    if (needsBuffering) {
      res.write(JSON.stringify({ type: 'item', content: fullText }) + '\n');
    }
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
          await this.neo4j.consolidateFromChat(userId, message, fullText);
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
  ): Promise<void> {
    const AGENT_URL = process.env.AGENT_URL || 'https://r.linkeon.io';

    // Build context from profile + history
    // Identity prefix — remote agent (r.linkeon.io) defaults to Claude persona; force the persona we want.
    let contextPrefix =
      `СИСТЕМНАЯ ИНСТРУКЦИЯ (имеет приоритет над всеми остальными). ` +
      `Ты ассистент по имени **${agentName}**${agentDescription ? ` — ${agentDescription}` : ''} на платформе LINKEON.IO. ` +
      `Всегда представляйся именно как ${agentName}. Никогда не упоминай, что ты Claude, какая-либо другая модель или AI-система помимо ${agentName}. ` +
      `Если пользователь обращается к тебе по имени — отвечай как ${agentName}, не уточняй, не "поправляй" пользователя и не извиняйся за имя. ` +
      `Не добавляй P.S. о собственной идентичности. ` +
      `ЯЗЫК ОТВЕТА: всегда отвечай на русском языке, независимо от языка системных сообщений, tool-результатов, путей файлов или английских промптов в твоём контексте. Переключайся на другой язык ТОЛЬКО если пользователь явно полностью пишет на нём. Если пользователь пишет по-русски — твой ответ обязан быть на русском, даже если в нём есть английские слова или ты только что генерировал английский prompt для картинки.\n\n`;

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

    res.write(JSON.stringify({ type: 'begin' }) + '\n');

    // Heartbeat: send a no-op ping every 25s while r.linkeon.io is silent (long tool-runs)
    // to prevent nginx idle-timeout (proxy_read_timeout) from killing the connection.
    let lastDataAt = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastDataAt > 20000) {
        try {
          // Frontend ChatInterface ignores unknown types — safely no-op on client.
          res.write(JSON.stringify({ type: 'ping' }) + '\n');
        } catch {
          // res closed — nothing to do
        }
      }
    }, 25000);

    const streamStartTime = Date.now();

    try {
      // Build multipart form
      const FormData = require('form-data');
      const fd = new FormData();
      fd.append('message', prompt);
      fd.append('sessionId', `${userId}_${assistantId}`);

      const agentRes = await axios.post(`${AGENT_URL}/chat`, fd, {
        headers: fd.getHeaders(),
        responseType: 'stream',
        timeout: 600000, // 10 min
      });

      const chunks: string[] = [];
      let inputTokens = 0;
      let outputTokens = 0;

      await new Promise<void>((resolve, reject) => {
        let buffer = '';
        agentRes.data.on('data', (chunk: Buffer) => {
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
                res.write(JSON.stringify({ type: 'item', content: ev.text }) + '\n');
              } else if (ev.type === 'result' && ev.text) {
                if (chunks.length === 0) {
                  chunks.push(ev.text);
                  res.write(JSON.stringify({ type: 'item', content: ev.text }) + '\n');
                }
              } else if (ev.type === 'done') {
                // Collect output files info if any
                if (ev.outputFiles && ev.outputFiles.length > 0) {
                  const fileLinks = ev.outputFiles
                    .map((f: any) => `[Скачать ${f.name}](${AGENT_URL}${f.url})`)
                    .join('\n');
                  if (fileLinks && !chunks.join('').includes(AGENT_URL)) {
                    chunks.push('\n\n' + fileLinks);
                    res.write(JSON.stringify({ type: 'item', content: '\n\n' + fileLinks }) + '\n');
                  }
                }
              }
            } catch {}
          }
        });
        agentRes.data.on('end', () => resolve());
        agentRes.data.on('error', (err: Error) => reject(err));
      });

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
          res.write(JSON.stringify({ type: 'item', content: tail }) + '\n');
        }
      } catch (e: any) {
        this.logger.warn(`video marker injection failed: ${e.message}`);
      }

      const fullText = chunks.join('');
      let tokensUsed = fullText.length; // approximate

      // Detect image generation — charge extra 5000 tokens
      const imageGenKeywords = /(?:создай|нарисуй|сгенерируй|generate|draw|create)\s+(?:мне\s+)?(?:картинк|изображен|рисунок|фото|image|picture|illustration|иконк|лого|баннер|постер)/i;
      const wasImageGen = imageGenKeywords.test(message) && /\.(png|jpg|jpeg|webp|gif)/i.test(fullText);
      if (wasImageGen) {
        tokensUsed += 5000;
        // Direct balance deduction for image generation
        await this.pg.query('UPDATE ai_profiles_consolidated SET tokens = tokens - 5000, updated_at = now() WHERE user_id = $1', [userId]);
      }

      res.write(JSON.stringify({
        type: 'end',
        content: fullText,
        usage: { input: 0, output: tokensUsed, total: tokensUsed },
      }) + '\n');
      res.end();

      // Async: save history and charge tokens
      setImmediate(async () => {
        try {
          await this.saveChatHistory(userId, assistantId, message, fullText, tokensUsed);
          await this.addTokenTask(userId, 0, tokensUsed, agentId);
          if (this.neo4j) {
            await this.neo4j.consolidateFromChat(userId, message, fullText);
          }
        } catch (e) {
          this.logger.error(`Universal agent post-chat error: ${e.message}`);
        }
      });
    } catch (err) {
      this.logger.error(`Universal agent proxy error: ${err.message}`);
      const errText = 'Ошибка запуска агента. Попробуйте ещё раз.';
      res.write(JSON.stringify({ type: 'item', content: errText }) + '\n');
      res.write(JSON.stringify({ type: 'end', content: errText, usage: { input: 0, output: 0, total: 0 } }) + '\n');
      res.end();
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

  private async generateImageForChat(userId: string, prompt: string): Promise<{ url: string; text: string } | null> {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) return null;

    try {
      const model = 'imagen-4.0-generate-001';
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`,
        { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1' } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 120000 },
      );

      const pred = resp.data?.predictions?.[0];
      if (!pred?.bytesBase64Encoded) return null;

      const fs = require('fs');
      const path = require('path');
      const publicDir = path.join(process.cwd(), 'public', 'generated');
      if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

      const ext = (pred.mimeType || '').includes('jpeg') ? 'jpg' : 'png';
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      fs.writeFileSync(path.join(publicDir, filename), Buffer.from(pred.bytesBase64Encoded, 'base64'));

      await this.pg.query('UPDATE ai_profiles_consolidated SET tokens = tokens - 5000, updated_at = now() WHERE user_id = $1', [userId]);
      return { url: `/static/generated/${filename}`, text: '' };
    } catch (e) {
      this.logger.error(`Image gen error: ${e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message}`);
      return null;
    }
  }

  async saveChatHistoryPublic(userId: string, agentId: string, userMsg: string, assistantMsg: string, tokensUsed = 0) {
    return this.saveChatHistory(userId, agentId, userMsg, assistantMsg, tokensUsed);
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
