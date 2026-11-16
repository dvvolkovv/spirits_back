import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { relayAuthHeaders } from '../chat/relay-auth';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { relayProviderFields } from '../chat/answer-provider';
import { postRelayWithDrainRetry, DrainRetryOpts } from '../chat/relay-drain-retry';

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
    // клиент ОБЩИЙ — автоблог (BlogModule) и сценарист с режиссёром студии
    // роликов (ShortsWriterService, ShortsDirectorService; свой экземпляр
    // класса заведён в shorts.module.ts, с блогом не делится). Ролики идут
    // через модель рубильника; автоблог (редактор, отбор новостей) — всегда
    // Claude, ask(..., { followSwitch: false }). Без @Optional(): при поломке
    // DI старт упадёт (поймает smoke), а не студия молча останется на Claude;
    // тесты создают клиент через new без аргумента.
    private readonly globalProvider?: GlobalLlmProviderService,
  ) {}

  /** Повтор под шлагбаумом выката релея (полное расписание); тесты подменяют расписание. */
  private drainOpts: DrainRetryOpts = {
    onRetry: (attempt, delayMs) =>
      this.logger.warn(`релей обновляется или недоступен — повтор ${attempt} через ${delayMs} мс`),
  };

  /**
   * Один вызов релея. sessionId — новый на каждый пост: длинные сессии
   * у нас глючат посторонним текстом в ответе, а память здесь не нужна —
   * прошлые заголовки передаются прямо в промпте.
   *
   * opts.followSwitch — по умолчанию модель общего рубильника (поле provider
   * через relayProviderFields). false — рубильник не читается и полей модели
   * нет: релей идёт обычным путём (Claude, при его сбое — запасные), как до
   * рубильника.
   */
  async ask(systemPrompt: string, message: string, sessionId: string, opts: { followSwitch?: boolean } = {}): Promise<string> {
    const agentUrl = process.env.AGENT_URL || 'https://r.linkeon.io';
    const FormData = require('form-data');
    const provider = opts.followSwitch !== false
      ? (this.globalProvider ? await this.globalProvider.get() : 'claude')
      : null;
    // Форма multipart — поток: на каждый повтор под шлагбаумом — новая.
    const buildForm = () => {
      const fd = new FormData();
      fd.append('message', message);
      fd.append('systemPrompt', systemPrompt);
      fd.append('sessionId', sessionId);
      if (provider !== null) {
        for (const [k, v] of Object.entries(relayProviderFields(false, provider))) fd.append(k, v);
      }
      return fd;
    };

    const resp = await postRelayWithDrainRetry(() => {
      const fd = buildForm();
      return axios.post(`${agentUrl}/chat`, fd, {
        headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
        responseType: 'stream',
        timeout: 300_000,
        maxRedirects: 0,
      });
    }, this.drainOpts);

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
