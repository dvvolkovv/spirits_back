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
const SPOKEN = [/девятьсот\s+восемьдесят\s+девять,?\s+пятьдесят/iu, /две\s+тысячи,?\s+сто\s+двадцать\s+два/iu];

const DIGIT_RUN_RE = /\+?\d[\d \t().-]*\d/g;

export function isCrisisText(text: string): boolean {
  const s = String(text || '');
  for (const m of s.match(DIGIT_RUN_RE) ?? []) {
    const digits = m.replace(/\D/g, '');
    if (HOTLINE_TAILS.some((t) => digits.includes(t))) return true;
  }
  return SPOKEN.some((re) => re.test(s));
}

export function isCrisisConversation(turns: readonly Turn[]): boolean {
  return turns.some((t) => t.role === 'assistant' && isCrisisText(t.text));
}
