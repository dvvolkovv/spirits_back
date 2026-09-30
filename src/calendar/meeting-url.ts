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
