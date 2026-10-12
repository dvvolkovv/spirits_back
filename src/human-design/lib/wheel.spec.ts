const expect = Object.assign((actual: unknown, _message?: string) => globalThis.expect(actual), globalThis.expect) as typeof globalThis.expect;
import { GATE_ORDER, LINE_SPAN, WHEEL_START, gateLine, minutesToLineBoundary, normalizeDegrees } from './wheel';

describe('колесо ворот', () => {
  it('64 разных ворот, каждые ровно один раз', () => {
    expect(GATE_ORDER).toHaveLength(64);
    expect([...GATE_ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
  });

  it('41-е ворота начинаются на 302°', () => {
    expect(gateLine(WHEEL_START)).toEqual({ gate: 41, line: 1 });
    expect(gateLine(WHEEL_START - 1e-9)).toEqual({ gate: 60, line: 6 });
  });

  // Опорные точки — из независимых таблиц градусов (см. комментарий в wheel.ts):
  // 25-е ворота стоят на точке весеннего равноденствия, 15-е — на летнем
  // солнцестоянии, 46-е — на осеннем равноденствии, 10-е — на зимнем.
  it('ворота на точках равноденствий и солнцестояний', () => {
    expect(gateLine(0).gate).toBe(25);
    expect(gateLine(90).gate).toBe(15);
    expect(gateLine(180).gate).toBe(46);
    expect(gateLine(270).gate).toBe(10);
  });

  it('начала ворот по таблице градусов', () => {
    // 27-е — 2°00′ Тельца, 31-е — 2°00′ Льва, 28-е — 2°00′ Скорпиона.
    expect(gateLine(32)).toEqual({ gate: 27, line: 1 });
    expect(gateLine(122)).toEqual({ gate: 31, line: 1 });
    expect(gateLine(212)).toEqual({ gate: 28, line: 1 });
    // 20-е — 0°07′30″ Близнецов.
    expect(gateLine(60.125)).toEqual({ gate: 20, line: 1 });
    expect(gateLine(60.124)).toEqual({ gate: 8, line: 6 });
  });

  it('шесть линий по 56′15″', () => {
    expect(LINE_SPAN).toBe(0.9375);
    for (let line = 1; line <= 6; line++) {
      expect(gateLine(WHEEL_START + (line - 1) * LINE_SPAN + 0.0001)).toEqual({ gate: 41, line });
    }
    expect(gateLine(WHEEL_START + 6 * LINE_SPAN)).toEqual({ gate: 19, line: 1 });
  });

  it('долгота за пределами 0–360 приводится', () => {
    expect(normalizeDegrees(-1)).toBe(359);
    expect(normalizeDegrees(721)).toBe(1);
    expect(gateLine(-58)).toEqual(gateLine(302));
  });

  it('расстояние до границы линии', () => {
    expect(minutesToLineBoundary(WHEEL_START)).toBe(0);
    expect(minutesToLineBoundary(WHEEL_START + LINE_SPAN / 2)).toBeCloseTo(28.125, 6);
    expect(minutesToLineBoundary(WHEEL_START + LINE_SPAN - 1 / 60)).toBeCloseTo(1, 6);
  });

  it('не число — RangeError, а не молча undefined', () => {
    expect(() => gateLine(Number.NaN)).toThrow(RangeError);
    expect(() => gateLine(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  // Вся таблица целиком: ворота — это гексаграммы И-цзин (номер — по Вэнь-вану),
  // а колесо от 41-х ворот идёт по кругу Шао Юна в двоичном коде гексаграмм:
  // 49…32, 0…31, 63…50. Любая перестановка ворот этот тест роняет.
  it('колесо — круг Шао Юна: от 41-х ворот 49…32, 0…31, 63…50', () => {
    const TRI = { qian: 7, dui: 6, li: 5, zhen: 4, xun: 3, kan: 2, gen: 1, kun: 0 } as const; // линии снизу вверх
    const UPPER = ['qian', 'zhen', 'kan', 'gen', 'kun', 'xun', 'li', 'dui'] as const;
    const KING_WEN: Record<keyof typeof TRI, number[]> = { // строка — нижняя триграмма
      qian: [1, 34, 5, 26, 11, 9, 14, 43],   zhen: [25, 51, 3, 27, 24, 42, 21, 17],
      kan:  [6, 40, 29, 4, 7, 59, 64, 47],   gen:  [33, 62, 39, 52, 15, 53, 56, 31],
      kun:  [12, 16, 8, 23, 2, 20, 35, 45],  xun:  [44, 32, 48, 18, 46, 57, 50, 28],
      li:   [13, 55, 63, 22, 36, 37, 30, 49], dui: [10, 54, 60, 41, 19, 61, 38, 58],
    };
    const bits = new Map<number, number>();
    for (const [lo, row] of Object.entries(KING_WEN)) {
      row.forEach((n, j) => bits.set(n, (TRI[lo as keyof typeof TRI] << 3) | TRI[UPPER[j]]));
    }
    const want = Array.from({ length: 64 }, (_, i) => { const j = (i + 14) % 64; return j < 32 ? 63 - j : j - 32; });
    expect(GATE_ORDER.map((g) => bits.get(g))).toEqual(want);
  });
});
