import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { Response } from 'express';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(private readonly pg: PgService) {}

  async streamChat(
    userId: string,
    message: string,
    assistantId: string,
    sessionId: string,
    profileText: string,
    res: Response,
  ): Promise<void> {
    // Get agent
    const agentRes = await this.pg.query(
      'SELECT * FROM agents WHERE id = $1 OR name = $1 LIMIT 1',
      [assistantId],
    );
    const agent = agentRes.rows[0];
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Get chat history
    const histRes = await this.pg.query(
      `SELECT messages FROM custom_chat_history
       WHERE user_id = $1 AND agent_id = $2
       ORDER BY updated_at DESC LIMIT 1`,
      [userId, String(assistantId)],
    );
    const existingMessages: any[] = histRes.rows[0]?.messages || [];
    const recentHistory = existingMessages.slice(-10); // last 10 messages as context

    // Build system prompt with profile context
    let systemPrompt = agent.system_prompt || '';
    if (profileText && profileText.trim()) {
      systemPrompt = `${systemPrompt}\n\n--- Профиль пользователя ---\n${profileText}`;
    }

    // Build messages array for LLM
    const llmMessages: any[] = [
      { role: 'system', content: systemPrompt },
    ];
    for (const msg of recentHistory) {
      llmMessages.push({ role: msg.type === 'user' ? 'user' : 'assistant', content: msg.content });
    }
    llmMessages.push({ role: 'user', content: message });

    // Set streaming headers
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Write begin marker
    res.write(JSON.stringify({ type: 'begin' }) + '\n');

    const chunks: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    const model = 'openai/gpt-4o-mini';

    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model,
          messages: llmMessages,
          stream: true,
        },
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
                res.write(JSON.stringify({ type: 'item', content }) + '\n');
              }
              if (json.usage) {
                inputTokens = json.usage.prompt_tokens || 0;
                outputTokens = json.usage.completion_tokens || 0;
              }
            } catch {}
          }
        });
        response.data.on('end', () => resolve());
        response.data.on('error', (err: Error) => reject(err));
      });
    } catch (e) {
      this.logger.error(`OpenRouter stream error: ${e.message}`);
      res.write(JSON.stringify({ type: 'item', content: 'Ошибка соединения с ассистентом.' }) + '\n');
      chunks.push('Ошибка соединения с ассистентом.');
    }

    const fullText = chunks.join('');
    res.write(JSON.stringify({ type: 'end', content: fullText }) + '\n');
    res.end();

    // Async: save to DB after response sent
    setImmediate(async () => {
      try {
        await this.saveChatHistory(userId, String(assistantId), message, fullText);
        await this.addTokenTask(userId, inputTokens, outputTokens, String(agent.id));
      } catch (e) {
        this.logger.error(`Post-chat save error: ${e.message}`);
      }
    });
  }

  private async saveChatHistory(userId: string, agentId: string, userMsg: string, assistantMsg: string) {
    const now = new Date().toISOString();
    const newMessages = [
      { id: uuidv4(), type: 'user', content: userMsg, timestamp: now },
      { id: uuidv4(), type: 'assistant', content: assistantMsg, timestamp: now },
    ];

    const existing = await this.pg.query(
      'SELECT id, messages FROM custom_chat_history WHERE user_id = $1 AND agent_id = $2 ORDER BY updated_at DESC LIMIT 1',
      [userId, agentId],
    );

    if (existing.rows.length > 0) {
      const msgs = existing.rows[0].messages || [];
      const updated = [...msgs, ...newMessages].slice(-50); // keep last 50 messages
      await this.pg.query(
        'UPDATE custom_chat_history SET messages = $1::jsonb, updated_at = now() WHERE id = $2',
        [JSON.stringify(updated), existing.rows[0].id],
      );
    } else {
      await this.pg.query(
        `INSERT INTO custom_chat_history (user_id, agent_id, session_id, messages, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, now(), now())`,
        [userId, agentId, `${userId}_${agentId}`, JSON.stringify(newMessages)],
      );
    }
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

  async getChatHistory(userId: string, assistantId: string): Promise<{ messages: any[] }> {
    const res = await this.pg.query(
      `SELECT messages FROM custom_chat_history
       WHERE user_id = $1 AND agent_id = $2
       ORDER BY updated_at DESC LIMIT 1`,
      [userId, String(assistantId)],
    );
    if (!res.rows.length) return { messages: [] };
    const messages = res.rows[0].messages || [];
    // Return last 6 messages (matching n8n behavior)
    return { messages: messages.slice(-6) };
  }

  async deleteChatHistory(userId: string, assistantId: string) {
    await this.pg.query(
      'DELETE FROM custom_chat_history WHERE user_id = $1 AND agent_id = $2',
      [userId, String(assistantId)],
    );
    return { success: true };
  }
}
