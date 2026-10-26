/**
 * Числа для озвучки. Финальную реплику пишет код, а не сценарист: число
 * ассистентов берётся из базы (правило текста 1), и словами — чтобы на
 * экране и в голосе было одно и то же, а SpeechKit не читал цифру по-своему.
 */

const UNITS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

/** Целое 0–999 словами, мужской род («один ассистент», «два ассистента»). */
export function numberWordsRu(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) {
    throw new Error(`numberWordsRu: ждём целое 0–999, получено ${n}`);
  }
  if (n === 0) return UNITS[0];
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) parts.push(HUNDREDS[hundreds]);
  if (rest >= 10 && rest < 20) {
    parts.push(TEENS[rest - 10]);
  } else {
    const tens = Math.floor(rest / 10);
    const units = rest % 10;
    if (tens) parts.push(TENS[tens]);
    if (units) parts.push(UNITS[units]);
  }
  return parts.join(' ');
}

const FORMS: Record<string, string> = { one: 'ассистент', few: 'ассистента', many: 'ассистентов', other: 'ассистента' };
const rules = new Intl.PluralRules('ru-RU');

/** «восемнадцать ассистентов» — падеж из Intl.PluralRules, как plural.ts студии. */
export function assistantsInWords(n: number): string {
  return `${numberWordsRu(n)} ${FORMS[rules.select(n)]}`;
}

/**
 * Финальная реплика — дословно как в принятом образце (владелец, 25.10.2026).
 * «Линкеон» кириллицей: латиницу SpeechKit читает непредсказуемо.
 */
export function finalLine(assistantsCount: number): string {
  return `Линкеон — ${assistantsInWords(assistantsCount)}. Ссылка — в описании и в профиле.`;
}
