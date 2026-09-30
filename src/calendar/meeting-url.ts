/**
 * Распознать ссылку на видеовстречу в тексте события (описание/место/URL) — чтобы лаунчер мог
 * показать кнопку «Присоединиться» без ухода в приложение. Точечно по известным провайдерам, а не
 * «первый попавшийся URL» (в описании могут быть посторонние ссылки). Полный текст всё равно виден
 * пользователю целиком, так что нераспознанный провайдер не теряется — просто без отдельной кнопки.
 */
const MEETING_PATTERNS: RegExp[] = [
  /https?:\/\/[a-z0-9.-]*\bzoom\.us\/[^\s<>"']+/i,
  /https?:\/\/meet\.google\.com\/[^\s<>"']+/i,
  /https?:\/\/teams\.microsoft\.com\/[^\s<>"']+/i,
  /https?:\/\/teams\.live\.com\/[^\s<>"']+/i,
  /https?:\/\/telemost\.yandex\.[a-z]+\/[^\s<>"']+/i,
  /https?:\/\/[a-z0-9.-]*\bwebex\.com\/[^\s<>"']+/i,
  /https?:\/\/whereby\.com\/[^\s<>"']+/i,
  /https?:\/\/meet\.jit\.si\/[^\s<>"']+/i,
  /https?:\/\/[a-z0-9.-]*\bkontur\.ru\/[^\s<>"']+/i, // Контур.Толк
  // РФ-провайдеры видеосвязи (корп-календари)
  /https?:\/\/[a-z0-9.-]*\bdion\.vc\/[^\s<>"']+/i,       // Dion (Сбер)
  /https?:\/\/[a-z0-9.-]*\bktalk\.ru\/[^\s<>"']+/i,       // Контур.Толк (новый домен)
  /https?:\/\/[a-z0-9.-]*\bvideomost\.com\/[^\s<>"']+/i,  // Видеомост
  /https?:\/\/[a-z0-9.-]*\bjazz\.sber\.ru\/[^\s<>"']+/i,  // SberJazz
];

/** Обрезать «хвостовую» пунктуацию, налипшую на URL в свободном тексте. */
function trimUrl(u: string): string {
  return u.replace(/[.,;:)\]}>'"]+$/, '');
}

/** Нормализовать поле детали (описание/место): строка, trim, CRLF→LF, разумный кап длины. */
export function normDetail(v: any): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\r\n/g, '\n').trim();
  if (!s) return undefined;
  return s.length > 4000 ? s.slice(0, 4000) + '…' : s;
}

export function detectMeetingUrl(...texts: Array<string | undefined | null>): string | undefined {
  const hay = texts.filter((t): t is string => !!t && t.trim().length > 0).join('\n');
  if (!hay) return undefined;
  for (const re of MEETING_PATTERNS) {
    const m = hay.match(re);
    if (m) return trimUrl(m[0]);
  }
  return undefined;
}

/**
 * Итоговая ссылка на встречу: сперва известный провайдер в описании/месте; иначе — если ПОЛЕ МЕСТА
 * целиком является ссылкой (частый паттерн Outlook/корп: в location лежит только URL созвона), берём
 * её. Описание НЕ трактуем так (там бывают посторонние ссылки).
 */
export function pickMeetingUrl(description?: string | null, location?: string | null): string | undefined {
  const known = detectMeetingUrl(description, location);
  if (known) return known;
  const loc = (location ?? '').trim();
  if (/^https?:\/\/\S+$/i.test(loc)) return trimUrl(loc);
  return undefined;
}
