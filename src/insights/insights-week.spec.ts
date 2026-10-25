import { previousWeekMsk, weekLabel, weekOf } from './insights-week';

describe('неделя по Москве', () => {
  it('в понедельник 07:07 МСК прогон берёт прошлую неделю', () => {
    const w = previousWeekMsk(new Date('2026-10-26T04:07:00Z'));
    expect(w.weekStart).toBe('2026-10-19');
    expect(w.start.toISOString()).toBe('2026-10-18T21:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-25T21:00:00.000Z');
  });

  it('в воскресенье 23:59 МСК неделя ещё не закончилась — берётся позапрошлая', () => {
    expect(previousWeekMsk(new Date('2026-10-25T20:59:00Z')).weekStart).toBe('2026-10-12');
  });

  it('в понедельник 00:30 МСК (ещё воскресенье по UTC) берётся только что закончившаяся', () => {
    expect(previousWeekMsk(new Date('2026-10-25T21:30:00Z')).weekStart).toBe('2026-10-19');
  });

  it('неделя задаётся только понедельником', () => {
    expect(() => weekOf('2026-10-20')).toThrow(/не понедельник/);
    expect(() => weekOf('20.10.2026')).toThrow(/формате/);
  });

  it('подпись недели — внутри месяца и через границу', () => {
    expect(weekLabel('2026-10-19')).toBe('19–25 окт');
    expect(weekLabel('2026-09-28')).toBe('28 сен – 4 окт');
  });
});
