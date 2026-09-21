import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Разбор SSE-потока релея. Вынесен отдельной чистой функцией, чтобы
 * тестироваться без сети.
 */
export function collectRelayText(raw: string): string {
  const chunks: string[] = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'delta' || ev.type === 'text') chunks.push(ev.text || '');
      else if (ev.type === 'result' && ev.text && chunks.length === 0) chunks.push(ev.text);
    } catch { /* битую строку пропускаем: поток важнее одной записи */ }
  }
  return chunks.join('');
}

@Injectable()
export class BlogRelayClient {
  private readonly logger = new Logger(BlogRelayClient.name);

  /**
   * Один вызов релея. sessionId — новый на каждый пост: длинные сессии
   * у нас глючат посторонним текстом в ответе, а память здесь не нужна —
   * прошлые заголовки передаются прямо в промпте.
   */
  async ask(systemPrompt: string, message: string, sessionId: string): Promise<string> {
    const agentUrl = process.env.AGENT_URL || 'https://r.linkeon.io';
    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('message', message);
    fd.append('systemPrompt', systemPrompt);
    fd.append('sessionId', sessionId);

    const resp = await axios.post(`${agentUrl}/chat`, fd, {
      headers: fd.getHeaders(),
      responseType: 'stream',
      timeout: 300_000,
    });

    const raw = await new Promise<string>((resolve, reject) => {
      let buf = '';
      resp.data.on('data', (c: Buffer) => { buf += c.toString(); });
      resp.data.on('end', () => resolve(buf));
      resp.data.on('error', reject);
    });

    const text = collectRelayText(raw).trim();
    if (!text) throw new Error('blog: релей вернул пустой ответ');
    return text;
  }
}
