/**
 * Человекочитаемая фраза о том, когда выйдет одобренный пост — по-русски и
 * по-московски: «в четверг, 24 сентября, в 10:00 МСК» / «сегодня в 10:00
 * МСК» / «завтра в 10:00 МСК».
 *
 * Сознательно НЕ используем `Intl.DateTimeFormat('ru-RU', ...)`:
 *  1. Смена дня недели и месяца через Intl нужна для готового NOMINATIVE-
 *     названия («среда», «сентябрь»), а по-русски после предлога «в» нужен
 *     винительный падеж («в среду», не «в среда»), да ещё и с чередованием
 *     предлога («во вторник», а не «в вторник»). Строкой из Intl это не
 *     решить без отдельной таблицы падежей поверх — то есть таблица нужна
 *     в любом случае, так что Intl тут ничего не упрощает.
 *  2. Даже там, где Intl отдал бы готовое слово, он на это не гарантированно
 *     годен: часть сборок Node собрана с урезанной ICU (только английская
 *     локаль), и `Intl.DateTimeFormat('ru-RU', ...)` в таких сборках не
 *     бросает ошибку, а молча откатывается на английскую локаль —
 *     `resolvedOptions().locale` при этом вернёт не `ru`, а `en-...`, и в
 *     тексте вместо «четверг» окажется «Thursday». Проверено на двух живых
 *     окружениях (мак и тестовая нода, `process.versions.icu` полный на
 *     обеих) — риск не воспроизведён здесь, но раз он в принципе существует
 *     для чужой сборки Node, надёжнее вообще не зависеть от ICU, чем
 *     держать в голове, на какой машине форматирование однажды тихо
 *     сломается.
 *
 * Со сдвигом на московское время тоже не привлекаем таймзонную базу: Москва
 * весь год UTC+3 без перевода часов (та же посылка, что в `blog-slots.ts`),
 * поэтому московские компоненты даты — это компоненты даты, сдвинутой на
 * три часа вперёд и прочитанной как UTC.
 */

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * ISO-нумерация дня недели (1 = понедельник … 7 = воскресенье) → готовый
 * фрагмент «в <день недели винительного падежа>» с правильным предлогом.
 */
const WEEKDAY_IN: Record<number, string> = {
  1: 'в понедельник',
  2: 'во вторник',
  3: 'в среду',
  4: 'в четверг',
  5: 'в пятницу',
  6: 'в субботу',
  7: 'в воскресенье',
};

/** Название месяца в родительном падеже: «24 сентября», не «24 сентябрь». */
const MONTH_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

interface MskParts {
  year: number;
  month: number; // 0-based, как у Date
  day: number;
  isoDow: number; // 1..7
  hour: number;
  minute: number;
}

function toMskParts(d: Date): MskParts {
  const shifted = new Date(d.getTime() + MSK_OFFSET_MS);
  const isoDow = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    isoDow,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

const sameMskDate = (a: MskParts, b: MskParts): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * @param slot момент публикации (как хранится `blog_post.slot_at` — UTC)
 * @param now момент, относительно которого решаем «сегодня/завтра» (UTC).
 *   Явный параметр, а не `new Date()` внутри — иначе функция перестаёт быть
 *   чистой и её нельзя протестировать без мока времени.
 */
export function formatSlotWhen(slot: Date, now: Date): string {
  const slotParts = toMskParts(slot);
  const nowParts = toMskParts(now);
  const time = `${pad2(slotParts.hour)}:${pad2(slotParts.minute)} МСК`;

  if (sameMskDate(slotParts, nowParts)) return `сегодня в ${time}`;

  const tomorrowParts = toMskParts(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  if (sameMskDate(slotParts, tomorrowParts)) return `завтра в ${time}`;

  const weekday = WEEKDAY_IN[slotParts.isoDow];
  const month = MONTH_GENITIVE[slotParts.month];
  return `${weekday}, ${slotParts.day} ${month}, в ${time}`;
}
