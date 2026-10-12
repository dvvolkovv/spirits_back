import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { BODIES, designDate, longitudes } from './ephemeris';
import { gateLine, minutesToLineBoundary } from './wheel';
import { localToUtc } from './time';

/**
 * Условие выката (спека, «Точность»): наш расчёт совпадает с эталоном Swiss
 * Ephemeris по воротам и линиям всех 26 активаций 300 рождений 1920–2025.
 * Исключение — пограничные случаи: долгота эталона ближе 1′ к границе линии,
 * там решает погрешность эфемерид. Их тест считает и печатает отдельно.
 *
 * Эталон проверяет ПОЗИЦИИ. Колесо ворот и правила типа, авторитета, профиля и
 * определённости он не проверяет — у него та же таблица; это работа карт ручной
 * сверки (manual.test.ts). Генератор — scripts/hd-reference.py.
 */
interface RefChart {
  zone: string;
  local: string;
  utc: string;
  designUtc: string;
  p: number[];
  d: number[];
  pg: string[];
  dg: string[];
}
const reference = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'reference.json'), 'utf8')) as {
  meta: { bodies: string[]; count: number };
  charts: RefChart[];
};
const charts = reference.charts;

const arcsec = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180) * 3600;
const gl = (lon: number) => {
  const g = gateLine(lon);
  return `${g.gate}.${g.line}`;
};

/** Наши долготы личности и дизайна для карты эталона. */
const ours = new Map(
  charts.map((c) => {
    const birth = new Date(c.utc);
    const design = designDate(birth);
    return [c.utc, { design, p: longitudes(birth), d: longitudes(design) }];
  }),
);

describe('эталон Swiss Ephemeris', () => {
  it('300 рождений, тела в порядке BODIES', () => {
    expect(charts).toHaveLength(300);
    expect(reference.meta.bodies).toEqual([...BODIES]);
  });

  it('таблица ворот эталона и наша дают одно и то же по долготам эталона', () => {
    for (const c of charts) {
      expect(c.p.map(gl), c.utc).toEqual(c.pg);
      expect(c.d.map(gl), c.utc).toEqual(c.dg);
    }
  });

  it('ворота и линии 26 активаций совпадают — кроме пограничных', () => {
    const mismatches: string[] = [];
    const boundary: string[] = [];
    let checked = 0;
    for (const c of charts) {
      const o = ours.get(c.utc)!;
      for (const [label, lon, refLon, refGl] of [
        ['личность', o.p, c.p, c.pg],
        ['дизайн', o.d, c.d, c.dg],
      ] as const) {
        BODIES.forEach((body, i) => {
          checked += 1;
          const got = gl(lon[body]);
          if (got === refGl[i]) return;
          const line = `${c.utc} ${label} ${body}: ${got}, эталон ${refGl[i]}`;
          (minutesToLineBoundary(refLon[i]) < 1 ? boundary : mismatches).push(line);
        });
      }
    }
    console.log(`эталон: сверено ${checked} активаций, пограничных расхождений ${boundary.length}`);
    for (const b of boundary) console.log(`  пограничное: ${b}`);
    expect(checked).toBe(300 * 26);
    expect(mismatches).toEqual([]);
  });

  // 60″ — заявленная точность astronomy-engine («within ±1 arcminute»), а не
  // наша прикидка. Факт на этих 300 картах (ревью 08.10.2026): максимум 36″
  // (Луна дизайна), Нептун стабильно 11–18″, ≥30″ — два случая из 7800.
  // Ужесточать порог — только вместе со сменой библиотеки эфемерид.
  it('долготы ближе 1′, момент дизайна — ближе 2 минут', () => {
    const far: string[] = [];
    for (const c of charts) {
      const o = ours.get(c.utc)!;
      BODIES.forEach((body, i) => {
        if (arcsec(o.p[body], c.p[i]) >= 60) far.push(`${c.utc} личность ${body}`);
        if (arcsec(o.d[body], c.d[i]) >= 60) far.push(`${c.utc} дизайн ${body}`);
      });
      if (Math.abs(o.design.getTime() - new Date(c.designUtc).getTime()) >= 120_000) far.push(`${c.utc} момент дизайна`);
    }
    expect(far).toEqual([]);
  });

  it('местное время → UTC совпадает с zoneinfo эталона', () => {
    const wrong: string[] = [];
    for (const c of charts) {
      const [date, time] = c.local.split('T');
      const conv = localToUtc({ date, time }, c.zone);
      const got = conv.kind === 'ok' ? conv.utc.toISOString() : conv.kind;
      if (got !== c.utc) wrong.push(`${c.local} ${c.zone}: ${got}, эталон ${c.utc}`);
    }
    expect(wrong).toEqual([]);
  });
});
