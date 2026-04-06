import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
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
    res.status(200);
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

  async getChatHistory(userId: string, assistantId: string): Promise<{ messages: any[] }> {
    const sessionId = `${userId}_${assistantId}`;
    const res = await this.pg.query(
      `SELECT id, sender_type, content, created_at FROM custom_chat_history
       WHERE session_id = $1
       ORDER BY created_at DESC LIMIT 6`,
      [sessionId],
    );
    const messages = res.rows.reverse().map(r => ({
      id: String(r.id),
      type: r.sender_type === 'human' ? 'user' : 'assistant',
      content: r.content,
      timestamp: r.created_at,
    }));
    return { messages };
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
