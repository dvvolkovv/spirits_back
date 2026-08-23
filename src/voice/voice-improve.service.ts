import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * «Причесать» надиктованный голосом русский текст [2026-08-23]: расставить пунктуацию/заглавные и
 * поправить очевидные ошибки падежей/согласования от распознавания речи — БЕЗ изменения смысла.
 * Вызывается ТОЛЬКО по явному согласию пользователя (кнопка «Улучшить» + предупреждение о внешнем ИИ
 * на клиенте). Fail-safe: любой сбой/нет ключа → возвращаем исходный текст (ничего не теряем).
 */
@Injectable()
export class VoiceImproveService {
  private readonly logger = new Logger(VoiceImproveService.name);

  async improve(text: string): Promise<string> {
    const src = (text || '').trim();
    if (!src) return src;
    const openaiKey = process.env.OPENAI_API_KEY;
    const routerKey = process.env.OPENROUTER_API_KEY;
    const key = openaiKey || routerKey;
    if (!key) return src;
    const url = openaiKey ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
    const model = openaiKey ? (process.env.IMPROVE_MODEL || 'gpt-4o-mini') : 'openai/gpt-4o-mini';
    const system =
      'Ты корректируешь русский текст, надиктованный голосом (распознавание речи). Задача: расставь ' +
      'пунктуацию и заглавные буквы, исправь ОЧЕВИДНЫЕ ошибки падежей и согласования, возникшие при ' +
      'распознавании. СТРОГО: не меняй смысл, не добавляй и не убирай факты и слова по существу, ' +
      'не отвечай на текст и не комментируй — только исправь его. Верни ТОЛЬКО исправленный текст.';
    try {
      const resp = await axios.post(
        url,
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: src },
          ],
          temperature: 0.2,
        },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 20000 },
      );
      const out = resp.data?.choices?.[0]?.message?.content;
      const cleaned = typeof out === 'string' ? out.trim() : '';
      return cleaned || src;
    } catch (e: any) {
      this.logger.warn(`voice improve failed: ${e?.message}`);
      return src;
    }
  }
}
