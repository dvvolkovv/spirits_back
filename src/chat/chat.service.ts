import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { KlingService } from '../misc/kling.service';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { Response } from 'express';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private anthropic: Anthropic | null = null;

  constructor(private readonly pg: PgService, @Optional() private readonly neo4j: Neo4jService, @Optional() private readonly kling: KlingService) {
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

    // Build system prompt with platform context + profile
    const allAgents = await this.pg.query('SELECT name, description FROM agents ORDER BY id');
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
При первом приветствии кратко представься и упомяни других ассистентов. Используй только текст без таблиц. Старайся давать промежуточные результаты после 3-4 уточнений — не затягивай диалог.
Ты умеешь генерировать изображения — если пользователь попросит, скажи что уже генерируешь.`;

    let systemPrompt = `${platformContext}\n\n${agent.system_prompt || ''}`;
    if (profileText && profileText.trim()) {
      systemPrompt = `${systemPrompt}\n\n--- Профиль пользователя ---\n${profileText}`;
    }

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

    // Detect image generation request before calling LLM
    const imageKeywords = /(?:создай|нарисуй|сгенерируй|нарисуй|генерация|generate|draw|create)\s+(?:мне\s+)?(?:картинк|изображен|рисунок|фото|image|picture|illustration)/i;
    const drawKeywords = /^(?:нарисуй|draw)\s+/i;
    if (imageKeywords.test(message) || drawKeywords.test(message)) {
      res.write(JSON.stringify({ type: 'begin', metadata: { nodeName: 'Image Echo Agent' } }) + '\n');
      try {
        const imageResult = await this.generateImageForChat(userId, message);
        if (imageResult) {
          const fullText = `![Сгенерированное изображение](${imageResult.url})`;
          res.write(JSON.stringify({ type: 'item', content: fullText }) + '\n');
          res.write(JSON.stringify({ type: 'end', content: fullText }) + '\n');
          res.end();
          setImmediate(async () => {
            try {
              await this.saveChatHistory(userId, String(assistantId), message, fullText);
            } catch (e) { this.logger.error(`Post-chat save error: ${e.message}`); }
          });
          return;
        }
      } catch (e) {
        this.logger.error(`Image gen error: ${e.message}`);
        const errText = 'Не удалось сгенерировать изображение. Попробуйте ещё раз.';
        res.write(JSON.stringify({ type: 'item', content: errText }) + '\n');
        res.write(JSON.stringify({ type: 'end', content: errText }) + '\n');
        res.end();
        setImmediate(async () => {
          try { await this.saveChatHistory(userId, String(assistantId), message, errText); } catch {}
        });
        return;
      }
    }

    // Regular text chat — collect full response then send cleaned
    res.write(JSON.stringify({ type: 'begin' }) + '\n');

    const chunks: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    if (this.anthropic) {
      try {
        const stream = this.anthropic.messages.stream({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          system: systemPrompt,
          messages: llmMessages,
        });
        stream.on('text', (text) => chunks.push(text));
        const finalMessage = await stream.finalMessage();
        inputTokens = finalMessage.usage?.input_tokens || 0;
        outputTokens = finalMessage.usage?.output_tokens || 0;
      } catch (e) {
        this.logger.error(`Anthropic stream error: ${e.message}`);
        chunks.push('Ошибка соединения с ассистентом.');
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
              'HTTP-Referer': 'https://b.linkeon.io',
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
                if (content) chunks.push(content);
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
    const isМаша = agent.name === 'Маша';
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
    res.write(JSON.stringify({ type: 'item', content: fullText }) + '\n');
    res.write(JSON.stringify({ type: 'end', content: fullText, usage: { input: inputTokens, output: outputTokens, total: tokensUsed } }) + '\n');
    res.end();

    // Async: save to DB and consolidate profile after response sent
    setImmediate(async () => {
      try {
        await this.saveChatHistory(userId, String(assistantId), message, fullText);
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
    if (!this.kling) return null;
    const result = await this.kling.generateImage(prompt);
    if (!result) return null;

    await this.pg.query('UPDATE ai_profiles_consolidated SET tokens = tokens - 5000, updated_at = now() WHERE user_id = $1', [userId]);
    return { url: result.url, text: '' };
  }

  private async saveChatHistory(userId: string, agentId: string, userMsg: string, assistantMsg: string) {
    const sessionId = `${userId}_${agentId}`;
    const agentNum = /^\d+$/.test(agentId) ? parseInt(agentId, 10) : null;

    // Insert user message
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'human', $2, $3, 'text')`,
      [sessionId, agentNum, userMsg],
    );

    // Insert assistant message
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'ai', $2, $3, 'text')`,
      [sessionId, agentNum, assistantMsg],
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
      `SELECT id, sender_type, content, created_at FROM custom_chat_history
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
