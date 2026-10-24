/**
 * Неделя бота — с понедельника 00:00 по воскресенье 23:59:59 по Москве.
 * Москва — UTC+3 круглый год (перевода часов нет с 2014), поэтому сдвиг
 * постоянный и Intl здесь не нужен.
 */

const MSK_OFFSET_MS = 3 * 3600_000;
const DAY_MS = 86_400_000;

export interface Week {
  start: Date;
  end: Date;
  /** Понедельник по Москве, 'YYYY-MM-DD'. */
  weekStart: string;
}

export function weekOf(weekStart: string): Week {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new Error(`неделя не в формате YYYY-MM-DD: ${weekStart}`);
  }
  const mondayMsk = Date.parse(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(mondayMsk) || new Date(mondayMsk).getUTCDay() !== 1) {
    throw new Error(`${weekStart} — не понедельник`);
  }
  return {
    start: new Date(mondayMsk - MSK_OFFSET_MS),
    end: new Date(mondayMsk + 7 * DAY_MS - MSK_OFFSET_MS),
    weekStart,
  };
}

/** Прошедшая неделя к моменту now. */
export function previousWeekMsk(now: Date): Week {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const sinceMonday = (msk.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - sinceMonday);
  return weekOf(new Date(thisMonday - 7 * DAY_MS).toISOString().slice(0, 10));
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** «19–25 окт», «28 сен – 4 окт». */
export function weekLabel(weekStart: string): string {
  const a = new Date(`${weekStart}T00:00:00Z`);
  const b = new Date(a.getTime() + 6 * DAY_MS);
  const ma = MONTHS[a.getUTCMonth()];
  const mb = MONTHS[b.getUTCMonth()];
  return ma === mb
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${mb}`
    : `${a.getUTCDate()} ${ma} – ${b.getUTCDate()} ${mb}`;
}
