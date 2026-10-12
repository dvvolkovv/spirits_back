const expect = Object.assign((actual: unknown, _message?: string) => globalThis.expect(actual), globalThis.expect) as typeof globalThis.expect;
import { BODIES, designDate, longitudes } from './ephemeris';

/**
 * Долготы Swiss Ephemeris 2.10.03 (файлы sepl_18/semo_18, видимые
 * геоцентрические, истинное равноденствие даты, SE_TRUE_NODE), сняты
 * pyswisseph на тестовой ноде 08.10.2026. Порядок — BODIES. Дизайн — момент
 * swe.solcross_ut(Солнце − 88°). Полная сверка по 300 картам — reference.test.ts.
 */
const SWISS = [
  {
    utc: '1990-03-12T11:25:00Z',
    design: '1989-12-15T15:03:16.493Z',
    lon: [351.625109, 171.625109, 316.102305, 136.102305, 183.218065, 345.522581, 306.600812,
      300.601743, 91.211936, 293.101051, 279.140717, 284.238407, 227.656249],
  },
  {
    utc: '2001-11-23T22:50:00Z',
    design: '2001-08-26T21:58:58.850Z',
    lon: [241.719121, 61.719121, 87.485919, 267.485919, 342.341215, 235.540486, 229.301596,
      319.165002, 104.938991, 72.264591, 321.154427, 306.371534, 254.597482],
  },
  {
    utc: '1962-01-30T13:00:00Z',
    design: '1961-11-04T19:59:57.425Z',
    lon: [310.166213, 130.166213, 138.076059, 318.076059, 238.378714, 322.028993, 310.913518,
      298.122247, 317.309254, 303.160739, 149.274015, 223.433574, 159.547232],
  },
];

/** Разность долгот в угловых секундах, с учётом перехода через 0°. */
const arcsec = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180) * 3600;

describe('эфемериды против Swiss Ephemeris', () => {
  for (const c of SWISS) {
    it(`${c.utc}: все 13 тел ближе 1′`, () => {
      const lon = longitudes(new Date(c.utc));
      const far = BODIES.map((body, i) => ({ body, sec: arcsec(lon[body], c.lon[i]) })).filter((x) => x.sec >= 60);
      expect(far).toEqual([]);
    });

    it(`${c.utc}: момент дизайна — в пределах 2 минут`, () => {
      const ours = designDate(new Date(c.utc)).getTime();
      expect(Math.abs(ours - new Date(c.design).getTime())).toBeLessThan(120_000);
    });
  }

  it('Земля напротив Солнца, южный узел напротив северного', () => {
    const lon = longitudes(new Date(SWISS[0].utc));
    expect(arcsec(lon.earth, lon.sun + 180)).toBeLessThan(1e-6);
    expect(arcsec(lon.southNode, lon.northNode + 180)).toBeLessThan(1e-6);
  });

  it('Солнце дизайна ровно на 88° позади', () => {
    const birth = new Date(SWISS[1].utc);
    const sunBirth = longitudes(birth).sun;
    const sunDesign = longitudes(designDate(birth)).sun;
    expect(arcsec(sunDesign, sunBirth - 88)).toBeLessThan(0.5);
  });
});
