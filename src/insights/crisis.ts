import { CRISIS_HOTLINES } from '../chat/crisis-rule';
import type { Turn } from './insights.types';

/**
 * Кризисный разговор — тот, где ассистент дал номер телефона доверия из
 * кризисного правила. Такой разговор модель не читает, в сводке — только число.
 *
 * Сравниваются десять последних цифр номера: ассистент мог записать «8 (495)…»
 * вместо «+7 (495)…» или без разделителей.
 */
const HOTLINE_TAILS = CRISIS_HOTLINES.map((p) => p.replace(/\D/g, '').slice(-10));

// В звонке номера звучат словами — формы из CALL_CRISIS_RULE (voice-host/src/prompts.ts).
// Сверяются после нормализации: номер диктуется «группами цифр», с паузами, и
// распознавание речи ставит между группами точки, а не запятые.
const SPOKEN = [/девятьсот восемьдесят девять пятьдесят/u, /две тысячи сто двадцать два/u];

// Слова, которых вне кризисного протокола у ассистента почти не бывает. Лишний
// пропуск разговора безвреден, а пропущенный кризис ушёл бы модели целиком.
const PHRASES = [/телефон доверия/u, /психологической помощи/u];

const DIGIT_RUN_RE = /\+?\d[\d \t().-]*\d/g;

/** Нижний регистр, ё → е, знаки препинания и переводы строк — в пробел. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function isCrisisText(text: string): boolean {
  const s = String(text || '');
  for (const m of s.match(DIGIT_RUN_RE) ?? []) {
    const digits = m.replace(/\D/g, '');
    if (HOTLINE_TAILS.some((t) => digits.includes(t))) return true;
  }
  const n = normalize(s);
  return SPOKEN.some((re) => re.test(n)) || PHRASES.some((re) => re.test(n));
}

export function isCrisisConversation(turns: readonly Turn[]): boolean {
  return turns.some((t) => t.role === 'assistant' && isCrisisText(t.text));
}
