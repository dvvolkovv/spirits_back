/**
 * Проверки текста, который пишет модель. Всё, что похоже на цитату или на
 * утечку, отбрасывается целиком, а не правится: правка оставила бы
 * полуцитату.
 */

/** Ряды цифр, почта, метки обезличивания. */
export const FORBIDDEN_RE = /\d{3,}|@|\[(?:имя|телефон|почта|число|ссылка)/u;

const QUOTED_RE = /[«"“„]([^»"”“]*)[»"”“]/gu;

/**
 * Цитата — признак того, что модель переписала слова человека. Короткое в
 * кавычках — обычно название раздела или кнопки («Продукты», «Студия»): без
 * него предложение по продукту не сформулировать. Длинное — уже цитата.
 */
export function hasLongQuote(s: string): boolean {
  for (const m of s.matchAll(QUOTED_RE)) {
    const inner = m[1].trim();
    if (Array.from(inner).length > 30 || inner.split(/\s+/).filter(Boolean).length > 3) return true;
  }
  return false;
}

/**
 * Числа о людях — цифрами и словами: «4 человека», «у 3 пользователей»,
 * «2 разговора», «5 раз», «один пользователь», «несколько человек». Им не
 * место в тексте находки: он уходит в analysis_md задачи бэклога, а оттуда —
 * темой в публичный блог. Для находки «1 человек» это ровно тот сигнал,
 * который надо прятать.
 */
export const PEOPLE_COUNT_RE =
  /(?:\d+|(?<!\p{L})(?:одн\p{L}*|один|дв\p{L}*|тр\p{L}*|четыр\p{L}*|четвер\p{L}*|пят\p{L}*|нескольк\p{L}*|пар\p{L}*))\s+(?:чел|пользовател|клиент|разговор|раза?(?!\p{L}))/iu;

export function cleanLine(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s || FORBIDDEN_RE.test(s) || hasLongQuote(s)) return null;
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

/** JSON из ответа модели: без ```-ограды; если вокруг проза — первый массив или объект. */
export function parseModelJson(text: string): unknown {
  const s = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(s);
  } catch {
    // ниже — поиск внутри прозы
  }
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const close = s[start] === '[' ? ']' : '}';
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}
