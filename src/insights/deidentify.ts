/**
 * Обезличивание текста перед моделью. Это эвристика, а не гарантия (спека,
 * раздел «Обезличивание»): поэтому вдобавок выход модели проверяется
 * (insights-text.ts), разметка не хранится, а сводка уходит только владельцу.
 *
 * Порядок замен важен: ссылки и почта — первыми (в них бывают цифры и имена),
 * затем ряды цифр, затем имена.
 */

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()«»"]+/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// Ряд цифр с разделителями внутри строки. \s сюда нельзя: склеил бы цифры
// через перевод строки («шаг 1\n2 3» превратился бы в число).
const DIGIT_RUN_RE = /\+?\d[\d \t().-]*\d/g;

export function maskUrls(s: string): string {
  return s.replace(URL_RE, (m) => {
    const host = m.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').split(/[/?#:]/)[0].toLowerCase();
    return host ? `[ссылка: ${host}]` : '[ссылка]';
  });
}

export function maskEmails(s: string): string {
  return s.replace(EMAIL_RE, '[почта]');
}

export function maskDigits(s: string): string {
  return s.replace(DIGIT_RUN_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return '[телефон]';
    if (digits.length >= 6) return '[число]';
    return m;
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Имя и его падежные формы: «Владимир», «Владимира», «Владимиру». Основа без
 * последней гласной (Анна → Анн), за ней до трёх букв, по краям — не буква.
 */
function namePattern(raw: string): string | null {
  const n = raw.trim();
  const chars = Array.from(n);
  if (chars.length < 3) return null;
  const stem = chars.length >= 4 && /[аеёиоуыэюяьйaeiouy]$/iu.test(n) ? chars.slice(0, -1).join('') : n;
  return `(?<![\\p{L}\\p{N}])${escapeRe(stem)}\\p{L}{0,3}(?![\\p{L}\\p{N}])`;
}

export function maskNames(s: string, names: readonly string[]): string {
  const patterns = new Set<string>();
  for (const raw of names) {
    for (const piece of String(raw || '').split(/[\s,]+/)) {
      const p = namePattern(piece);
      if (p) patterns.add(p);
    }
  }
  if (!patterns.size) return s;
  // Длинные основы первыми: «Владимир» не должна съесть короткая «Влад».
  const re = new RegExp([...patterns].sort((a, b) => b.length - a.length).join('|'), 'giu');
  return s.replace(re, '[имя]');
}

export function deidentify(text: string, names: readonly string[] = []): string {
  return maskNames(maskDigits(maskEmails(maskUrls(String(text || '')))), names);
}
