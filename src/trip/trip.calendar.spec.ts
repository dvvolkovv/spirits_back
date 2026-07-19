import { eventsFromIcs, foldCalendarLines } from './calendar';

// Mirrors the real Yandex ICS shapes: a live weekly work-sync, an expired weekly recurrence
// (UNTIL in the past), a one-off inside the window, one before the conflict cutoff, one outside.
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Yekaterinburg:20260629T150000',
  'DTEND;TZID=Asia/Yekaterinburg:20260629T160000',
  'SUMMARY:Синк Триентос',
  'RRULE:FREQ=WEEKLY;BYDAY=MO;INTERVAL=1',
  'UID:sync1',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Yekaterinburg:20260326T090000',
  'SUMMARY:Массаж',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20260401T050000Z',
  'UID:massage1',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Yekaterinburg:20260719T090000',
  'SUMMARY:Ранняя встреча',
  'UID:early1',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Yekaterinburg:20260721T110000',
  'SUMMARY:Разовая встреча',
  'UID:once1',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Yekaterinburg:20260801T100000',
  'SUMMARY:Вне окна',
  'UID:out1',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const WIN_START = new Date('2026-07-18T00:00:00Z');
const WIN_END = new Date('2026-07-24T00:00:00Z');

describe('calendar eventsFromIcs', () => {
  it('expands weekly recurrence into the window and respects UNTIL', () => {
    const evs = eventsFromIcs(ICS, 'yandex', WIN_START, WIN_END);
    const titles = evs.map((e) => e.title);
    expect(titles).toContain('Синк Триентос'); // Monday 20 Jul falls in window
    expect(titles).not.toContain('Массаж'); // UNTIL 2026-04 — expired, must not appear
    expect(titles).not.toContain('Вне окна'); // 1 Aug — outside window
  });

  it('places the weekly Синк Триентос at 15:00 Yekaterinburg (10:00 UTC) on 20 Jul', () => {
    const sync = eventsFromIcs(ICS, 'yandex', WIN_START, WIN_END).find((e) => e.title === 'Синк Триентос');
    expect(sync?.at).toBe('2026-07-20T10:00:00.000Z');
  });

  it('populates end from DTEND (16:00 Yekaterinburg = 11:00 UTC), carried through the recurrence expansion', () => {
    const sync = eventsFromIcs(ICS, 'yandex', WIN_START, WIN_END).find((e) => e.title === 'Синк Триентос');
    expect(sync?.end).toBe('2026-07-20T11:00:00.000Z');
  });

  it('a one-off VEVENT with no DTEND gets a zero-duration end (node-ical\'s RFC 5545 §3.6.1 default: end = start for a date-time DTSTART with no DTEND/DURATION)', () => {
    const once = eventsFromIcs(ICS, 'yandex', WIN_START, WIN_END).find((e) => e.title === 'Разовая встреча');
    expect(once?.end).toBe(once?.at);
  });

  it('malformed ICS never throws — returns []', () => {
    expect(eventsFromIcs('not a calendar', 'x', WIN_START, WIN_END)).toEqual([]);
  });
});

describe('calendar foldCalendarLines', () => {
  const events = eventsFromIcs(ICS, 'yandex', WIN_START, WIN_END);
  const lines = foldCalendarLines(events, '2026-07-20T16:00:00', '2026-07-23T18:00:00');

  it('flags an event within 3h before departure (or during the trip) as a conflict', () => {
    const sync = lines.find((l) => l.text.includes('Синк Триентос'));
    expect(sync?.icon).toBe('⚠️');
    expect(sync?.tone).toBe('warn');
    expect(sync?.text).toContain('пересекается с выездом');
  });

  it('shows an event before the conflict window as informational (📅, no warn tone)', () => {
    const early = lines.find((l) => l.text.includes('Ранняя встреча'));
    expect(early?.icon).toBe('📅');
    expect(early?.tone).toBeUndefined();
  });
});
