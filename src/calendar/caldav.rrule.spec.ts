import { buildVEvent } from './caldav';
it('adds weekly BYDAY COUNT RRULE with TZID DTSTART', () => {
  const v = buildVEvent({ title: 'Отвезти Эдика', datetime: '2026-08-17T09:45:00', durationMin: 60,
    recurrence: { freq: 'weekly', byDay: ['MO','TU','WE','TH','FR'], count: 10 } } as any, 'uid1');
  expect(v).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10');
  expect(v).toContain('DTSTART;TZID=Asia/Yekaterinburg:20260817T094500');
  expect(v).toContain('DTSTAMP:');
});
it('until variant, no RRULE for single', () => {
  const u = buildVEvent({ title: 'x', datetime: '2026-08-17T09:00:00',
    recurrence: { freq: 'weekly', until: '2026-08-21' } } as any, 'u');
  expect(u).toMatch(/RRULE:FREQ=WEEKLY;UNTIL=20260821T235959Z/);
  const single = buildVEvent({ title: 'y', datetime: '2026-08-17T09:00:00' } as any, 'u2');
  expect(single).not.toContain('RRULE');
});
