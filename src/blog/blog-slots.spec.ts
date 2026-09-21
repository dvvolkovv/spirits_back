import { nextSlotAfter, isStaleNews, STALE_NEWS_DAYS } from './blog-slots';

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
