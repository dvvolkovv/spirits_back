/**
 * Колесо Human Design: 64 ворот по 5,625° (5°37′30″), у каждых — 6 линий по
 * 0,9375° (56′15″). 41-е ворота начинаются на 302° тропической долготы
 * (2° Водолея), дальше ворота идут по возрастанию долготы.
 *
 * Порядок сверен 08.10.2026 с двумя независимыми таблицами градусов:
 * barneyandflow.com/gate-zodiac-degrees и
 * bonniesorsby.com/human-design-gates-by-degree — совпал полностью.
 * Эталон Swiss Ephemeris колесо НЕ проверяет (он режет долготу той же
 * таблицей), целиком его держит тест на круг Шао Юна в wheel.test.ts,
 * косвенно — карты ручной сверки (manual.test.ts) через каналы и тип.
 */
export const GATE_ORDER = [
  41, 19, 13, 49, 30, 55, 37, 63, 22, 36, 25, 17, 21, 51, 42, 3,
  27, 24, 2, 23, 8, 20, 16, 35, 45, 12, 15, 52, 39, 53, 62, 56,
  31, 33, 7, 4, 29, 59, 40, 64, 47, 6, 46, 18, 48, 57, 32, 50,
  28, 44, 1, 43, 14, 34, 9, 5, 26, 11, 10, 58, 38, 54, 61, 60,
] as const;

/** Начало 41-х ворот, градусы тропической эклиптической долготы. */
export const WHEEL_START = 302;
export const GATE_SPAN = 360 / 64;
export const LINE_SPAN = GATE_SPAN / 6;

export interface GateLine {
  gate: number;
  line: number;
}

/** Приводит угол к [0, 360]; ровно 360 бывает при крошечном отрицательном входе — gateLine это учитывает. */
export function normalizeDegrees(degrees: number): number {
  const x = degrees % 360;
  return x < 0 ? x + 360 : x;
}

/** Ворота и линия для эклиптической долготы в градусах. */
export function gateLine(longitude: number): GateLine {
  if (!Number.isFinite(longitude)) throw new RangeError(`долгота должна быть числом: ${longitude}`);
  const offset = normalizeDegrees(longitude - WHEEL_START);
  // Страховка: индекс не выйдет за 383, если normalizeDegrees вернёт ровно 360 (крошечный отрицательный вход).
  const index = Math.min(Math.floor(offset / LINE_SPAN), 64 * 6 - 1);
  return { gate: GATE_ORDER[Math.floor(index / 6)], line: (index % 6) + 1 };
}

/** До ближайшей границы линии — в угловых минутах. */
export function minutesToLineBoundary(longitude: number): number {
  const within = normalizeDegrees(longitude - WHEEL_START) % LINE_SPAN;
  return Math.min(within, LINE_SPAN - within) * 60;
}
