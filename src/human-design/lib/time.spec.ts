const expect = Object.assign((actual: unknown, _message?: string) => globalThis.expect(actual), globalThis.expect) as typeof globalThis.expect;
import { formatOffset, localToUtc, wallFromParts, type Conversion } from './time';

/**
 * Ожидания посчитаны независимо — Python zoneinfo с tzdata 2026e — и совпали
 * с Intl в Node 22 (ICU, tzdata 2026a), 08.10.2026.
 */
const utc = (c: Conversion) => (c.kind === 'ok' ? c.utc.toISOString() : c.kind);
const at = (date: string, time: string, zone: string) => localToUtc({ date, time }, zone);

describe('местное время → UTC', () => {
  it('декретное время 1930: Москва с 21 июня — UTC+3 вместо UTC+2', () => {
    expect(utc(at('1930-06-20', '12:00', 'Europe/Moscow'))).toBe('1930-06-20T10:00:00.000Z');
    expect(utc(at('1930-06-22', '12:00', 'Europe/Moscow'))).toBe('1930-06-22T09:00:00.000Z');
  });

  it('1991–1992: Москва зимой UTC+2, потом снова UTC+3', () => {
    expect(utc(at('1991-03-31', '12:00', 'Europe/Moscow'))).toBe('1991-03-31T09:00:00.000Z');
    expect(utc(at('1991-12-01', '12:00', 'Europe/Moscow'))).toBe('1991-12-01T10:00:00.000Z');
    expect(utc(at('1992-02-01', '12:00', 'Europe/Moscow'))).toBe('1992-02-01T09:00:00.000Z');
    // Самара в ту же зиму осталась на UTC+4.
    expect(utc(at('1991-12-01', '12:00', 'Europe/Samara'))).toBe('1991-12-01T08:00:00.000Z');
  });

  it('2011–2014: «вечное летнее» время и возврат', () => {
    expect(utc(at('2012-01-15', '12:00', 'Europe/Moscow'))).toBe('2012-01-15T08:00:00.000Z');
    expect(utc(at('2015-01-15', '12:00', 'Europe/Moscow'))).toBe('2015-01-15T09:00:00.000Z');
    expect(utc(at('2012-01-15', '12:00', 'Asia/Yekaterinburg'))).toBe('2012-01-15T06:00:00.000Z');
    expect(utc(at('2015-01-15', '12:00', 'Asia/Yekaterinburg'))).toBe('2015-01-15T07:00:00.000Z');
    expect(utc(at('2012-01-15', '12:00', 'Europe/Kaliningrad'))).toBe('2012-01-15T09:00:00.000Z');
    expect(utc(at('2015-01-15', '12:00', 'Europe/Kaliningrad'))).toBe('2015-01-15T10:00:00.000Z');
  });

  it('пропущенный час: стрелки вперёд — спрашиваем', () => {
    const c = at('2010-03-28', '02:30', 'Europe/Moscow');
    expect(c.kind).toBe('gap');
    if (c.kind !== 'gap') return;
    expect(c.before.utc.toISOString()).toBe('2010-03-27T23:30:00.000Z');
    expect(c.before.offsetSeconds).toBe(3 * 3600);
    expect(c.after.utc.toISOString()).toBe('2010-03-27T22:30:00.000Z');
    expect(c.after.offsetSeconds).toBe(4 * 3600);
    expect(at('1930-06-21', '00:30', 'Europe/Moscow').kind).toBe('gap');
    expect(at('1992-01-19', '02:30', 'Europe/Moscow').kind).toBe('gap');
    expect(at('2011-03-27', '02:30', 'Europe/Moscow').kind).toBe('gap');
  });

  it('повторённый час: стрелки назад — спрашиваем', () => {
    const c = at('2014-10-26', '01:30', 'Europe/Moscow');
    expect(c.kind).toBe('ambiguous');
    if (c.kind !== 'ambiguous') return;
    expect(c.before.utc.toISOString()).toBe('2014-10-25T21:30:00.000Z');
    expect(c.after.utc.toISOString()).toBe('2014-10-25T22:30:00.000Z');
    expect(at('2010-10-31', '02:30', 'Europe/Moscow').kind).toBe('ambiguous');
    expect(at('1991-09-29', '02:30', 'Europe/Moscow').kind).toBe('ambiguous');
  });

  it('не только Россия: Нью-Йорк, пояса с получасом', () => {
    expect(at('2021-03-14', '02:30', 'America/New_York').kind).toBe('gap');
    expect(at('2021-11-07', '01:30', 'America/New_York').kind).toBe('ambiguous');
    expect(utc(at('1990-03-12', '14:25', 'Asia/Kolkata'))).toBe('1990-03-12T08:55:00.000Z');
    expect(utc(at('1990-03-12', '14:25', 'Asia/Kathmandu'))).toBe('1990-03-12T08:40:00.000Z');
    expect(utc(at('1990-03-12', '14:25', 'America/Los_Angeles'))).toBe('1990-03-12T22:25:00.000Z');
  });

  it('неизвестный пояс — ошибка, а не тихий UTC', () => {
    expect(() => at('1990-03-12', '14:25', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('подпись смещения', () => {
  it('часы, минуты, знак', () => {
    expect(formatOffset(3 * 3600)).toBe('UTC+3');
    expect(formatOffset(5.5 * 3600)).toBe('UTC+5:30');
    expect(formatOffset(5.75 * 3600)).toBe('UTC+5:45');
    expect(formatOffset(-8 * 3600)).toBe('UTC-8');
    expect(formatOffset(0)).toBe('UTC+0');
    // Местное среднее время 1920-х: секунды не показываем.
    expect(formatOffset(2 * 3600 + 31 * 60 + 19)).toBe('UTC+2:31');
  });
});

describe('разбор частей Intl', () => {
  const parts = (o: Record<string, string>): Intl.DateTimeFormatPart[] =>
    Object.entries(o).map(([type, value]) => ({ type: type as Intl.DateTimeFormatPartTypes, value }));
  it('24-часовой формат, полночь как «24» и 12-часовой с AM/PM дают одно и то же', () => {
    const base = { year: '1990', month: '03', day: '12', minute: '25', second: '00' };
    const at = (h: number) => Date.UTC(1990, 2, 12, h, 25, 0);
    expect(wallFromParts(parts({ ...base, hour: '14' }))).toBe(at(14));
    expect(wallFromParts(parts({ ...base, hour: '24' }))).toBe(at(0));
    expect(wallFromParts(parts({ ...base, hour: '02', dayPeriod: 'PM' }))).toBe(at(14));
    expect(wallFromParts(parts({ ...base, hour: '12', dayPeriod: 'AM' }))).toBe(at(0));
    expect(wallFromParts(parts({ ...base, hour: '12', dayPeriod: 'PM' }))).toBe(at(12));
  });
});
