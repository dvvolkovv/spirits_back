import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * «Фокус дня» для домашнего экрана [2026-08-23].
 *
 * Утренний настрой от Райи — тёплое многострочное послание (приветствие + контекст + собственно
 * посыл). Раньше в виджет уезжали первые 100 символов = приветствие + обрыв на полуслове, из
 * которого посыл непонятен (owner). Здесь мы дистиллируем послание в ОДНУ короткую фразу — суть
 * дня — дешёвой LLM (gpt-4o-mini), и кэшируем в памяти по метке времени сообщения: один вызов на
 * новое послание (виджет опрашивается воркером раз в ~30 мин — на кэше это бесплатно).
 *
 * Fail-safe: нет ключа/сбой LLM → аккуратный сниппет (без приветствия, по границе предложения),
 * что всё равно лучше прежнего обрыва. Смысл не выдумывается — только сжимается реальный текст Райи.
 */
@Injectable()
export class EnergyFocusService {
  private readonly logger = new Logger(EnergyFocusService.name);
  /** userId → { ts: метка времени исходного сообщения, focus }. Синглтон-провайдер, живёт с процессом. */
  private readonly cache = new Map<string, { ts: string; focus: string }>();

  /** Короткая суть дневного послания Райи. `srcTs` — created_at сообщения (ключ инвалидации кэша). */
  async focusFor(userId: string, content: string, srcTs: string): Promise<string | null> {
    const src = (content || '').trim();
    if (!src) return null;
    const cached = this.cache.get(userId);
    if (cached && cached.ts === srcTs && cached.focus) return cached.focus;
    const focus = (await this.distill(src)) || this.cleanSnippet(src);
    if (focus) this.cache.set(userId, { ts: srcTs, focus });
    return focus;
  }

  /** Дистилляция посыла в одну фразу дешёвой LLM. null → нет ключа/сбой (тогда сниппет-фолбэк). */
  private async distill(text: string): Promise<string | null> {
    const openaiKey = process.env.OPENAI_API_KEY;
    const routerKey = process.env.OPENROUTER_API_KEY;
    const key = openaiKey || routerKey;
    if (!key) return null;
    const url = openaiKey
      ? 'https://api.openai.com/v1/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions';
    const model = openaiKey ? process.env.ENERGY_FOCUS_MODEL || 'gpt-4o-mini' : 'openai/gpt-4o-mini';
    const system =
      'Тебе дают тёплое утреннее послание-настрой на день от ассистента (астролог-психолог). Выдели ' +
      'СУТЬ — посыл дня — и верни ОДНУ короткую фразу (8–16 слов): что человеку держать в фокусе или ' +
      'каким быть сегодня. Своими словами, по-русски, тепло и ясно. БЕЗ приветствия, без обращения по ' +
      'имени, без кавычек и без пояснений. Только сама фраза. Не выдумывай того, чего нет в послании.';
    try {
      const resp = await axios.post(
        url,
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
          temperature: 0.3,
          max_tokens: 80,
        },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 20000 },
      );
      const out = resp.data?.choices?.[0]?.message?.content;
      let cleaned = typeof out === 'string' ? out.trim() : '';
      cleaned = cleaned.replace(/^["«»']+|["«»']+$/g, '').trim(); // снять случайные кавычки
      return cleaned || null;
    } catch (e: any) {
      this.logger.warn(`energy focus distill failed: ${e?.message}`);
      return null;
    }
  }

  /** Фолбэк без LLM: убрать приветствие и отдать первую самодостаточную фразу по границе предложения. */
  private cleanSnippet(text: string): string {
    let t = text.replace(/\s+/g, ' ').trim();
    // Снять ведущее приветствие ("Доброе утро, Дмитрий." / "Добрый день," и т.п.).
    t = t.replace(/^добр(ое|ый)\s+(утро|день|вечер)[^.!?]*[.!?]\s*/i, '').trim();
    if (t.length <= 140) return t;
    const cut = t.slice(0, 160);
    const lastEnd = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    if (lastEnd >= 60) return cut.slice(0, lastEnd + 1).trim();
    const sp = cut.lastIndexOf(' ');
    return (sp > 60 ? cut.slice(0, sp) : cut).trim() + '…';
  }
}
