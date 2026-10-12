const jestExpect = (globalThis as unknown as { expect: jest.Expect }).expect;
const expect = Object.assign(<T>(actual: T, _message?: string) => jestExpect(actual), jestExpect);
import { calculateChart, chartFromUtc, type Activation } from './chart';
import { BODIES } from './ephemeris';

const gl = (xs: Activation[]) => xs.map((a) => `${a.gate}.${a.line}`).join(' ');

describe('карта по моменту в UTC', () => {
  // Ворота.линии — Swiss Ephemeris на тот же момент (см. ephemeris.test.ts).
  const c = chartFromUtc('1990-03-12T11:25:00Z');

  it('26 активаций как у Swiss Ephemeris', () => {
    expect(c.personality).toHaveLength(13);
    expect(c.design).toHaveLength(13);
    expect(gl(c.personality)).toBe('22.5 47.5 13.4 7.4 46.6 63.5 41.5 60.5 15.4 61.3 58.6 38.6 1.5');
    expect(gl(c.design)).toBe('11.2 12.2 13.5 7.5 31.1 38.3 41.2 14.4 52.4 38.5 58.1 38.3 1.4');
  });

  it('каналы, центры, профиль', () => {
    expect(c.channels).toEqual(['7-31', '12-22']);
    expect(c.definedCenters).toEqual(['throat', 'g', 'solarPlexus']);
    expect(c.openCenters).toEqual(['head', 'ajna', 'heart', 'spleen', 'sacral', 'root']);
    expect(c.profile).toBe('5/2');
  });

  it('стратегия следует из типа', () => {
    expect(c.type).toBe('manifestor');
    expect(c.strategy).toBe('inform');
  });

  it('сериализуется в JSON без потерь', () => {
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    expect(c.birthUtc).toBe('1990-03-12T11:25:00.000Z');
  });

  it('ворота без повторов и по возрастанию', () => {
    expect(c.gates).toEqual([...new Set(c.gates)].sort((a, b) => a - b));
  });

  it('BODIES[0] — Солнце: порядок тел входит в контракт', () => {
    expect(BODIES[0]).toBe('sun');
  });
});

describe('карта по местному времени — публичный вход', () => {
  it('обычное время — сразу карта и смещение пояса', () => {
    const r = calculateChart({ date: '1990-03-12', time: '14:25', zone: 'Europe/Moscow' });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.chart.birthUtc).toBe('1990-03-12T11:25:00.000Z');
    expect(r.offsetSeconds).toBe(3 * 3600);
  });

  it('час перевода стрелок без выбора — вопрос, с выбором — карта', () => {
    const ask = calculateChart({ date: '2014-10-26', time: '01:30', zone: 'Europe/Moscow' });
    expect(ask).toEqual({ kind: 'needsDstChoice', transition: 'ambiguous', beforeOffsetSeconds: 14400, afterOffsetSeconds: 10800 });
    const after = calculateChart({ date: '2014-10-26', time: '01:30', zone: 'Europe/Moscow', dst: 'after' });
    expect(after.kind === 'ok' && after.chart.birthUtc).toBe('2014-10-25T22:30:00.000Z');
  });

  it('выбор вне часа перевода ни на что не влияет', () => {
    const a = calculateChart({ date: '1990-03-12', time: '14:25', zone: 'Europe/Moscow', dst: 'before' });
    expect(a.kind === 'ok' && a.chart.birthUtc).toBe('1990-03-12T11:25:00.000Z');
  });

  it('неверный ввод и неизвестный пояс — RangeError', () => {
    expect(() => calculateChart({ date: '12.03.1990', time: '14:25', zone: 'Europe/Moscow' })).toThrow(RangeError);
    expect(() => calculateChart({ date: '1990-02-30', time: '14:25', zone: 'Europe/Moscow' })).toThrow(RangeError);
    expect(() => calculateChart({ date: '1990-03-12', time: '24:10', zone: 'Europe/Moscow' })).toThrow(RangeError);
    expect(() => calculateChart({ date: '1990-03-12', time: '14:25', zone: 'Mars/Olympus' })).toThrow(RangeError);
  });

  it('високосные годы: 1900 — не високосный, 2000 — високосный', () => {
    expect(() => calculateChart({ date: '1900-02-29', time: '14:25', zone: 'Europe/Moscow' })).toThrow(RangeError);
    expect(calculateChart({ date: '2000-02-29', time: '14:25', zone: 'Europe/Moscow' }).kind).toBe('ok');
  });

  it('час перевода стрелок вперёд (gap) на публичном слое', () => {
    const ask = calculateChart({ date: '2010-03-28', time: '02:30', zone: 'Europe/Moscow' });
    expect(ask).toEqual({ kind: 'needsDstChoice', transition: 'gap', beforeOffsetSeconds: 10800, afterOffsetSeconds: 14400 });
  });
});
