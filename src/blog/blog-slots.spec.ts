import {
  nextSlotAfter, nextFreeSlotAfter, upcomingSlots, NoFreeSlotError, FREE_SLOT_SEARCH_LIMIT,
  isStaleNews, STALE_NEWS_DAYS,
} from './blog-slots';

const DAYS = [1, 3, 5];   // пн, ср, пт
const HOUR = 10;          // 10:00 МСК = 07:00 UTC

describe('nextSlotAfter', () => {
  it('вторник днём → ближайшая среда 10:00 МСК', () => {
    // вт 2026-09-22 12:00 UTC
    const slot = nextSlotAfter(new Date('2026-09-22T12:00:00Z'), DAYS, HOUR);
    expect(slot.toISOString()).toBe('2026-09-23T07:00:00.000Z');
  });

  it('понедельник до слота → сегодня же', () => {
    const slot = nextSlotAfter(new Date('2026-09-21T05:00:00Z'), DAYS, HOUR);
    expect(slot.toISOString()).toBe('2026-09-21T07:00:00.000Z');
  });

  it('понедельник после слота → среда, а не сегодня задним числом', () => {
    const slot = nextSlotAfter(new Date('2026-09-21T08:00:00Z'), DAYS, HOUR);
    expect(slot.toISOString()).toBe('2026-09-23T07:00:00.000Z');
  });

  it('суббота → понедельник следующей недели', () => {
    const slot = nextSlotAfter(new Date('2026-09-26T12:00:00Z'), DAYS, HOUR);
    expect(slot.toISOString()).toBe('2026-09-28T07:00:00.000Z');
  });

  it('один слот в неделю тоже работает', () => {
    const slot = nextSlotAfter(new Date('2026-09-22T12:00:00Z'), [4], HOUR);
    expect(slot.toISOString()).toBe('2026-09-24T07:00:00.000Z');
  });
});

/**
 * Слот при одобрении — ближайший СВОБОДНЫЙ, а не ближайший вообще. Пока
 * одобренный пост держал очередь, два одобренных одновременно не возникали, и
 * «ближайший вообще» совпадал со свободным. Без блокировки два поста получили
 * бы один слот и вышли бы в канал одновременно.
 */
describe('nextFreeSlotAfter', () => {
  // пн 2026-09-21, 08:00 МСК: ближайший слот — сегодня 10:00 МСК
  const MON_MORNING = new Date('2026-09-21T05:00:00Z');
  const MON = '2026-09-21T07:00:00.000Z';
  const WED = '2026-09-23T07:00:00.000Z';
  const FRI = '2026-09-25T07:00:00.000Z';

  it('ничего не занято — тот же слот, что у nextSlotAfter', () => {
    const slot = nextFreeSlotAfter(MON_MORNING, DAYS, HOUR, []);
    expect(slot.toISOString()).toBe(nextSlotAfter(MON_MORNING, DAYS, HOUR).toISOString());
  });

  it('понедельник занят — среда', () => {
    const slot = nextFreeSlotAfter(MON_MORNING, DAYS, HOUR, [new Date(MON)]);
    expect(slot.toISOString()).toBe(WED);
  });

  it('понедельник и среда заняты — пятница', () => {
    const slot = nextFreeSlotAfter(MON_MORNING, DAYS, HOUR, [new Date(MON), new Date(WED)]);
    expect(slot.toISOString()).toBe(FRI);
  });

  /**
   * `slot_at` приходит из базы то объектом Date, то строкой в чужом поясе.
   * Сравнение по написанию сочло бы занятый слот свободным.
   */
  it('занятость сравнивается по моменту, а не по написанию', () => {
    const slot = nextFreeSlotAfter(MON_MORNING, DAYS, HOUR, ['2026-09-21T10:00:00+03:00']);
    expect(slot.toISOString()).toBe(WED);
  });

  /** Владелец может поставить пост не в слот расписания — такой пост слот расписания не занимает. */
  it('пост на 10:05 слот 10:00 не занимает', () => {
    const slot = nextFreeSlotAfter(MON_MORNING, DAYS, HOUR, [new Date('2026-09-21T07:05:00Z')]);
    expect(slot.toISOString()).toBe(MON);
  });

  it('занятые слоты в прошлом ничему не мешают', () => {
    const slot = nextFreeSlotAfter(MON_MORNING, DAYS, HOUR, [new Date('2026-09-18T07:00:00Z')]);
    expect(slot.toISOString()).toBe(MON);
  });

  it('последний слот в пределе поиска ещё находится', () => {
    const all = upcomingSlots(MON_MORNING, DAYS, HOUR, FREE_SLOT_SEARCH_LIMIT);
    const slot = nextFreeSlotAfter(MON_MORNING, DAYS, HOUR, all.slice(0, -1));
    expect(slot.toISOString()).toBe(all[all.length - 1].toISOString());
  });

  it('всё занято в пределе поиска — понятная ошибка, а не бесконечный поиск', () => {
    const all = upcomingSlots(MON_MORNING, DAYS, HOUR, FREE_SLOT_SEARCH_LIMIT);
    expect(() => nextFreeSlotAfter(MON_MORNING, DAYS, HOUR, all)).toThrow(NoFreeSlotError);
    expect(() => nextFreeSlotAfter(MON_MORNING, DAYS, HOUR, all)).toThrow(new RegExp(`${FREE_SLOT_SEARCH_LIMIT}.*занят`));
  });
});

describe('upcomingSlots', () => {
  it('ближайшие слоты расписания подряд, начиная со следующего', () => {
    const slots = upcomingSlots(new Date('2026-09-22T12:00:00Z'), DAYS, HOUR, 4);
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-09-23T07:00:00.000Z',   // ср
      '2026-09-25T07:00:00.000Z',   // пт
      '2026-09-28T07:00:00.000Z',   // пн
      '2026-09-30T07:00:00.000Z',   // ср
    ]);
  });
});

describe('isStaleNews', () => {
  it('новость моложе двух недель — свежая', () => {
    expect(isStaleNews(new Date('2026-09-10T10:00:00Z'), new Date('2026-09-21T10:00:00Z'))).toBe(false);
  });

  it('новость старше двух недель — протухла', () => {
    expect(isStaleNews(new Date('2026-09-01T10:00:00Z'), new Date('2026-09-21T10:00:00Z'))).toBe(true);
  });

  it('ровно на границе не считается протухшей', () => {
    const created = new Date('2026-09-07T10:00:00Z');
    const now = new Date(created.getTime() + STALE_NEWS_DAYS * 86400_000);
    expect(isStaleNews(created, now)).toBe(false);
  });
});
