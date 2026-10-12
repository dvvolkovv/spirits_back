const jestExpect = (globalThis as unknown as { expect: jest.Expect }).expect;
const expect = Object.assign(<T>(actual: T, _message?: string) => jestExpect(actual), jestExpect);
import { CENTER_GATES, CENTER_IDS, CHANNELS, channelKey } from './bodygraph';
import { CENTER_SHAPES, GATE_POINTS, GATE_RADIUS, VIEWBOX, channelHalves } from './layout';

const pts = (s: string) => s.split(' ').map((p) => p.split(',').map(Number) as [number, number]);

describe('геометрия схемы', () => {
  it('у каждых из 64 ворот есть точка', () => {
    expect(Object.keys(GATE_POINTS).map(Number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 64 }, (_, i) => i + 1),
    );
  });

  it('ворота стоят в своём центре', () => {
    for (const center of CENTER_IDS) {
      const shape = pts(CENTER_SHAPES[center].points);
      const xs = shape.map(([x]) => x);
      const ys = shape.map(([, y]) => y);
      for (const gate of CENTER_GATES[center]) {
        const [x, y] = GATE_POINTS[gate];
        expect(x, `${gate} в ${center}`).toBeGreaterThanOrEqual(Math.min(...xs));
        expect(x, `${gate} в ${center}`).toBeLessThanOrEqual(Math.max(...xs));
        expect(y, `${gate} в ${center}`).toBeGreaterThanOrEqual(Math.min(...ys));
        expect(y, `${gate} в ${center}`).toBeLessThanOrEqual(Math.max(...ys));
      }
    }
  });

  it('кружки ворот не наезжают друг на друга', () => {
    const all = Object.entries(GATE_POINTS);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [[a, [ax, ay]], [b, [bx, by]]] = [all[i], all[j]];
        expect(Math.hypot(ax - bx, ay - by), `${a} и ${b}`).toBeGreaterThanOrEqual(2 * GATE_RADIUS);
      }
    }
  });

  it('всё внутри viewBox', () => {
    for (const [x, y] of Object.values(GATE_POINTS)) {
      expect(x - GATE_RADIUS).toBeGreaterThanOrEqual(0);
      expect(x + GATE_RADIUS).toBeLessThanOrEqual(VIEWBOX.width);
      expect(y - GATE_RADIUS).toBeGreaterThanOrEqual(0);
      expect(y + GATE_RADIUS).toBeLessThanOrEqual(VIEWBOX.height);
    }
  });

  it('половины канала начинаются в своих воротах и сходятся в середине', () => {
    for (const ch of CHANNELS) {
      const [first, second] = channelHalves(ch).map(pts);
      expect(first[0], channelKey(ch)).toEqual([...GATE_POINTS[ch[0]]]);
      expect(second[second.length - 1], channelKey(ch)).toEqual([...GATE_POINTS[ch[1]]]);
      expect(first[first.length - 1], channelKey(ch)).toEqual(second[0]);
    }
  });

  it('20-34 огибает G слева', () => {
    const [first, second] = channelHalves([20, 34]).map(pts);
    const xs = [...first, ...second].map(([x]) => x);
    expect(Math.min(...xs)).toBeLessThan(136);
  });

  /** Расстояние от точки до отрезка [a, b]. */
  type Pt = readonly [number, number];
  const distToSegment = ([px, py]: Pt, [ax, ay]: Pt, [bx, by]: Pt) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  it('линии каналов не задевают чужие ворота', () => {
    for (const ch of CHANNELS) {
      const [a, b] = ch;
      const [first, second] = channelHalves(ch).map(pts);
      const points = [...first, ...second.slice(1)];
      for (const [gateStr, gatePoint] of Object.entries(GATE_POINTS)) {
        const gate = Number(gateStr);
        if (gate === a || gate === b) continue;
        for (let i = 0; i < points.length - 1; i++) {
          const d = distToSegment(gatePoint, points[i], points[i + 1]);
          expect(d, `канал ${channelKey(ch)} у ворот ${gate}`).toBeGreaterThanOrEqual(GATE_RADIUS + 1);
        }
      }
    }
  });
});
