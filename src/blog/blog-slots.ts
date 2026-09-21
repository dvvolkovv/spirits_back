/** Москва круглый год UTC+3 — перевода часов в России нет, зона фиксированная. */
const MSK_OFFSET_HOURS = 3;

/** Новость старше этого срока не публикуется: «а ещё месяц назад мы выпустили» никому не нужно. */
export const STALE_NEWS_DAYS = 14;

/**
 * Ближайший слот строго после `from`.
 * @param days дни недели по ISO-нумерации: 1 = понедельник … 7 = воскресенье
 * @param hourMsk час слота по Москве
 */
export function nextSlotAfter(from: Date, days: number[], hourMsk: number): Date {
  if (!days.length) throw new Error('blog: список дней слотов пуст');
  const utcHour = hourMsk - MSK_OFFSET_HOURS;

  for (let shift = 0; shift <= 14; shift++) {
    const day = new Date(Date.UTC(
      from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + shift,
      utcHour, 0, 0, 0,
    ));
    const isoDow = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (days.includes(isoDow) && day.getTime() > from.getTime()) return day;
  }
  throw new Error('blog: не нашёл слот за две недели вперёд');
}

export function isStaleNews(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > STALE_NEWS_DAYS * 86400_000;
}
