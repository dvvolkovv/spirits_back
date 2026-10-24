/**
 * Проверки текста, который пишет модель. Всё, что похоже на цитату или на
 * утечку, отбрасывается целиком, а не правится: правка оставила бы
 * полуцитату.
 */

/** Ряды цифр, почта, кавычки (признак цитаты), метки обезличивания. */
export const FORBIDDEN_RE = /\d{3,}|@|[«»"“”„]|\[(?:имя|телефон|почта|число|ссылка)/u;

/**
 * Цифры о людях: «4 человека», «у 3 пользователей», «2 разговора», «5 раз».
 * Им не место в тексте находки: он уходит в analysis_md задачи бэклога, а
 * оттуда — темой в публичный блог.
 */
export const PEOPLE_COUNT_RE = /\d+\s*(?:чел|пользовател|разговор|раза?(?!\p{L}))/iu;

export function cleanLine(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s || FORBIDDEN_RE.test(s)) return null;
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
