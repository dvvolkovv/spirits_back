import { expandOccurrences } from './recurrence';
describe('expandOccurrences', () => {
  it('weekly MO-FR count:10 from Mon 2026-08-17 → 17-21 & 24-28 Aug at 09:45', () => {
    const occ = expandOccurrences({ datetime: '2026-08-17T09:45:00',
      recurrence: { freq: 'weekly', byDay: ['MO','TU','WE','TH','FR'], count: 10 } });
    expect(occ).toHaveLength(10);
    expect(occ[0]).toBe('2026-08-17T09:45:00');
    expect(occ[4]).toBe('2026-08-21T09:45:00');
    expect(occ[5]).toBe('2026-08-24T09:45:00');
    expect(occ[9]).toBe('2026-08-28T09:45:00');
  });
  it('weekly with until (inclusive)', () => {
    const occ = expandOccurrences({ datetime: '2026-08-17T09:45:00',
      recurrence: { freq: 'weekly', byDay: ['MO','TU','WE','TH','FR'], until: '2026-08-21' } });
    expect(occ).toHaveLength(5);
    expect(occ[4]).toBe('2026-08-21T09:45:00');
  });
  it('daily interval 2, count 3', () => {
    const occ = expandOccurrences({ datetime: '2026-08-17T10:00:00',
      recurrence: { freq: 'daily', interval: 2, count: 3 } });
    expect(occ).toEqual(['2026-08-17T10:00:00','2026-08-19T10:00:00','2026-08-21T10:00:00']);
  });
  it('explicit dates sorted', () => {
    expect(expandOccurrences({ dates: ['2026-08-19T09:00:00','2026-08-17T09:00:00'] }))
      .toEqual(['2026-08-17T09:00:00','2026-08-19T09:00:00']);
  });
  it('single datetime', () => {
    expect(expandOccurrences({ datetime: '2026-08-17T09:00:00' })).toEqual(['2026-08-17T09:00:00']);
  });
  it('empty on nothing', () => { expect(expandOccurrences({})).toEqual([]); });
});
