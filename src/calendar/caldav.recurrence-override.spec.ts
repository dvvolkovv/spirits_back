import * as ical from 'node-ical';
import { expandCalDavEvents } from './caldav';

/**
 * Регрессия на «футбол трижды»: перенос одного вхождения повторяющегося события (RECURRENCE-ID
 * override) давал ДВА события — исходное время из RRULE + перенесённое из override. Разворачиваем
 * VEVENT'ы так же, как reportEvents (каждый блок парсится отдельно — сервер отдаёт master и override
 * раздельно), и проверяем, что остаётся ровно одно вхождение в перенесённое время.
 */
function parseBlocks(blocks: string[]): any[] {
  const out: any[] = [];
  for (const b of blocks) {
    const parsed: any = ical.parseICS(`BEGIN:VCALENDAR\n${b}\nEND:VCALENDAR`);
    for (const k of Object.keys(parsed)) {
      const ev = parsed[k];
      if (ev?.type === 'VEVENT' && ev.start) out.push(ev);
    }
  }
  return out;
}

const MASTER = [
  'BEGIN:VEVENT',
  'UID:football@yandex.ru',
  'SUMMARY:футбол у Эдика с Ваней',
  'DTSTART:20260905T090000Z', // еженедельно по субботам в 09:00 UTC
  'DTEND:20260905T100000Z',
  'RRULE:FREQ=WEEKLY',
  'END:VEVENT',
].join('\n');

// Перенос вхождения 2026-09-26 09:00 → 08:30 (RECURRENCE-ID = исходное время).
const OVERRIDE = [
  'BEGIN:VEVENT',
  'UID:football@yandex.ru',
  'SUMMARY:футбол у Эдика с Ваней',
  'RECURRENCE-ID:20260926T090000Z',
  'DTSTART:20260926T083000Z',
  'DTEND:20260926T093000Z',
  'END:VEVENT',
].join('\n');

const WIN_START = new Date('2026-09-24T00:00:00Z');
const WIN_END = new Date('2026-09-28T00:00:00Z');

it('перенесённое вхождение (RECURRENCE-ID) не двоится — одно событие в новое время', () => {
  const ves = parseBlocks([MASTER, OVERRIDE]);
  const out = expandCalDavEvents(ves, WIN_START, WIN_END);
  const football = out.filter((e) => /футбол/i.test(e.title));
  expect(football).toHaveLength(1);
  expect(football[0].at).toBe('2026-09-26T08:30:00.000Z'); // перенесённое, не 09:00
});

it('без override еженедельное вхождение отдаётся как раньше (одно, в исходное время)', () => {
  const ves = parseBlocks([MASTER]);
  const out = expandCalDavEvents(ves, WIN_START, WIN_END);
  const football = out.filter((e) => /футбол/i.test(e.title));
  expect(football).toHaveLength(1);
  expect(football[0].at).toBe('2026-09-26T09:00:00.000Z');
  expect(football[0].uid).toBe('football@yandex.ru-' + Date.parse('2026-09-26T09:00:00Z'));
});

it('EXDATE по-прежнему исключает вхождение', () => {
  const withExdate = MASTER.replace('RRULE:FREQ=WEEKLY', 'RRULE:FREQ=WEEKLY\nEXDATE:20260926T090000Z');
  const ves = parseBlocks([withExdate]);
  const out = expandCalDavEvents(ves, WIN_START, WIN_END);
  expect(out.filter((e) => /футбол/i.test(e.title))).toHaveLength(0);
});

it('разовое (не повторяющееся) событие сохраняет плоский uid', () => {
  const single = [
    'BEGIN:VEVENT',
    'UID:solo@yandex.ru',
    'SUMMARY:разовая встреча',
    'DTSTART:20260926T120000Z',
    'DTEND:20260926T130000Z',
    'END:VEVENT',
  ].join('\n');
  const out = expandCalDavEvents(parseBlocks([single]), WIN_START, WIN_END);
  expect(out).toHaveLength(1);
  expect(out[0].uid).toBe('solo@yandex.ru');
});
