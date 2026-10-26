import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * «Причесать» надиктованный голосом текст [2026-08-23]: расставить пунктуацию/заглавные и
 * поправить очевидные ошибки падежей/согласования от распознавания речи — БЕЗ изменения смысла.
 * Язык любой: диктовка слушает на языке профиля [2026-10-26], поэтому промпт не про «русский текст»
 * и прямо запрещает перевод. Написан по-английски намеренно: русский промпт тянул модель отвечать
 * по-русски (та же история, что с языковой директивой в LanguageService.buildDirective).
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
      'You proofread text dictated by voice (speech recognition output). The text may be in any language. ' +
      'Keep it in the SAME language it is written in and never translate it, not even partly: ' +
      'a German text stays German, an English text stays English, and so on. ' +
      'Add punctuation and capital letters, and fix OBVIOUS grammar errors caused by recognition ' +
      '(wrong endings, case, agreement). STRICTLY: do not change the meaning, do not add or remove ' +
      'facts or substantive words, do not answer the text or comment on it — only correct it. ' +
      'Return ONLY the corrected text.';
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
