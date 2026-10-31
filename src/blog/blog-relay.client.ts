import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { relayAuthHeaders } from '../chat/relay-auth';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { relayProviderFields } from '../chat/answer-provider';

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

  constructor(
    // Общий рубильник модели (spec 2026-10-31-global-llm-switch): этот
    // клиент ОБЩИЙ — фоновые посты автоблога (BlogModule) И сценарист с
    // режиссёром студии роликов (ShortsWriterService, ShortsDirectorService;
    // свой экземпляр класса заведён в shorts.module.ts, с блогом не делится)
    // идут через модель рубильника. Без @Optional(): при поломке DI старт
    // упадёт (поймает smoke), а не автоблог или студия молча останутся на
    // Claude; тесты создают клиент через new без аргумента.
    private readonly globalProvider?: GlobalLlmProviderService,
  ) {}

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
    const provider = this.globalProvider ? await this.globalProvider.get() : 'claude';
    for (const [k, v] of Object.entries(relayProviderFields(false, provider))) fd.append(k, v);

    const resp = await axios.post(`${agentUrl}/chat`, fd, {
      headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
      responseType: 'stream',
      timeout: 300_000,
      maxRedirects: 0,
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
