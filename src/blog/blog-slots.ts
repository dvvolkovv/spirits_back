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

/**
 * Сколько слотов расписания вперёд просматривает поиск свободного.
 *
 * Шестьдесят — это двадцать недель при трёх слотах в неделю и больше года при
 * одном. Одобренных постов наперёд у живого канала — единицы, так что до
 * предела поиск доходит, только если что-то сломалось; тогда лучше внятно
 * отказать, чем перебирать расписание до бесконечности.
 */
export const FREE_SLOT_SEARCH_LIMIT = 60;

/** Свободного слота нет: ближайшие заняты или его раз за разом уводили в гонке. */
export class NoFreeSlotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoFreeSlotError';
  }
}

/** Ближайшие `count` слотов расписания подряд, первый — строго после `from`. */
export function upcomingSlots(from: Date, days: number[], hourMsk: number, count: number): Date[] {
  const slots: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    cursor = nextSlotAfter(cursor, days, hourMsk);
    slots.push(cursor);
  }
  return slots;
}

/**
 * Ближайший СВОБОДНЫЙ слот строго после `from`.
 *
 * Пока одобренный пост держал очередь черновиков, «ближайший слот вообще»
 * совпадал со свободным: второго одобренного рядом быть не могло. Без этой
 * блокировки два поста получили бы один слот и вышли бы одновременно.
 *
 * Занятость сверяется по моменту времени, а не по написанию: `slot_at`
 * приходит из базы объектом Date, а от фронта — строкой в любом поясе. Пост,
 * поставленный не в слот расписания (10:05 вместо 10:00), слот расписания не
 * занимает — «занят» значит «тот же `slot_at`».
 *
 * @param taken моменты, которые уже держат другие посты
 * @throws NoFreeSlotError, если свободного нет в пределах `limit` слотов
 */
export function nextFreeSlotAfter(
  from: Date,
  days: number[],
  hourMsk: number,
  taken: Iterable<Date | string | number>,
  limit = FREE_SLOT_SEARCH_LIMIT,
): Date {
  const busy = new Set<number>();
  for (const t of taken) {
    if (t === null || t === undefined) continue;
    busy.add(new Date(t).getTime());
  }

  let cursor = from;
  for (let i = 0; i < limit; i++) {
    cursor = nextSlotAfter(cursor, days, hourMsk);
    if (!busy.has(cursor.getTime())) return cursor;
  }
  throw new NoFreeSlotError(`все ${limit} ближайших слотов расписания заняты`);
}

export function isStaleNews(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > STALE_NEWS_DAYS * 86400_000;
}
