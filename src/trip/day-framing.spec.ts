// day-framing.spec.ts
import { activeWindow, buildMorningFacts, buildEveningFacts, factsHash, framingPrompt } from './day-framing';

const ev = (at: string, title: string, end?: string) => ({ at, title, end });
const task = (title: string, status = 'pending', due?: string) => ({ uid: title, title, status, due });

describe('activeWindow', () => {
  it('before first event in the morning → morning', () => {
    const now = new Date('2026-08-06T02:30:00Z'); // 07:30 +05
    expect(activeWindow(now, [ev('2026-08-06T04:45:00Z', 'A')])).toBe('morning');
  });
  it('after the last event ends → evening', () => {
    const now = new Date('2026-08-06T14:10:00Z'); // 19:10 +05
    expect(activeWindow(now, [ev('2026-08-06T09:00:00Z', 'A', '2026-08-06T10:00:00Z')])).toBe('evening');
  });
  it('midday between windows → null', () => {
    const now = new Date('2026-08-06T09:30:00Z'); // 14:30 +05
    expect(activeWindow(now, [ev('2026-08-06T04:00:00Z', 'A'), ev('2026-08-06T15:00:00Z', 'B')])).toBeNull();
  });
  it('before 05:00 local → null (still night)', () => {
    const now = new Date('2026-08-05T23:30:00Z'); // 04:30 +05
    expect(activeWindow(now, [])).toBeNull();
  });
});

describe('buildMorningFacts', () => {
  it('lists events, unfinished tasks, first event, free slots', () => {
    const now = new Date('2026-08-06T02:30:00Z');
    const f = buildMorningFacts({
      now,
      events: [ev('2026-08-06T04:45:00Z', 'Занятие'), ev('2026-08-06T07:00:00Z', 'Доклад')],
      tasks: [task('умывание'), task('done1', 'done')],
    });
    expect(f.eventCount).toBe(2);
    expect(f.firstEvent?.title).toBe('Занятие');
    expect(f.unfinished.map((t: any) => t.title)).toContain('умывание');
    expect(f.unfinished.map((t: any) => t.title)).not.toContain('done1');
    expect(Array.isArray(f.freeSlots)).toBe(true);
  });
});

describe('buildEveningFacts', () => {
  it('counts unfinished, excludes done', () => {
    const now = new Date('2026-08-06T14:10:00Z');
    const f = buildEveningFacts({
      now,
      events: [ev('2026-08-06T09:00:00Z', 'A', '2026-08-06T10:00:00Z')],
      tasks: [task('дело1'), task('дело2'), task('готово', 'done')],
    });
    expect(f.unfinishedCount).toBe(2);
  });
});

describe('factsHash', () => {
  it('is stable and changes with content', () => {
    expect(factsHash({ a: 1 })).toBe(factsHash({ a: 1 }));
    expect(factsHash({ a: 1 })).not.toBe(factsHash({ a: 2 }));
  });
});

describe('framingPrompt', () => {
  it('framingPrompt embeds facts and forbids invention', () => {
    const f = buildMorningFacts({ now: new Date('2026-08-06T02:30:00Z'), events: [], tasks: [] });
    const p = framingPrompt(f);
    expect(p).toMatch(/только из этих фактов|не выдумывай/i);
    expect(p).toContain(JSON.stringify(f)); // факты переданы дословно
  });
});
