import {
  Body,
  Ecliptic,
  EclipticGeoMoon,
  GeoMoonState,
  GeoVector,
  MakeTime,
  RotateState,
  Rotation_EQJ_ECT,
  SunPosition,
} from 'astronomy-engine';
import { normalizeDegrees } from './wheel';

/** 13 тел карты — в принятом в Human Design порядке. */
export const BODIES = [
  'sun', 'earth', 'northNode', 'southNode', 'moon', 'mercury', 'venus',
  'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto',
] as const;
export type BodyId = (typeof BODIES)[number];

const PLANETS = {
  mercury: Body.Mercury,
  venus: Body.Venus,
  mars: Body.Mars,
  jupiter: Body.Jupiter,
  saturn: Body.Saturn,
  uranus: Body.Uranus,
  neptune: Body.Neptune,
  pluto: Body.Pluto,
} as const;

const RAD = Math.PI / 180;

/**
 * Истинный (оскулирующий) восходящий узел Луны: пересечение мгновенной
 * плоскости лунной орбиты с истинной эклиптикой даты. Плоскость — из векторов
 * положения и скорости Луны (r × v), так же считает SE_TRUE_NODE Swiss
 * Ephemeris. Формула Миуса (гл. 47, средний узел + 5 периодических членов)
 * расходится с SE_TRUE_NODE до 16′ (замер 08.10.2026, 3000 дат 1920–2025:
 * медиана 3,2′), а этот способ — до 16″.
 */
export function trueNodeLongitude(date: Date): number {
  const time = MakeTime(date);
  const s = RotateState(Rotation_EQJ_ECT(time), GeoMoonState(time));
  const hx = s.y * s.vz - s.z * s.vy;
  const hy = s.z * s.vx - s.x * s.vz;
  return normalizeDegrees(Math.atan2(hx, -hy) / RAD);
}

/** Видимые геоцентрические долготы 13 тел: тропический зодиак, истинная эклиптика даты. */
export function longitudes(date: Date): Record<BodyId, number> {
  const sun = SunPosition(date).elon;
  const node = trueNodeLongitude(date);
  const planets = Object.fromEntries(
    Object.entries(PLANETS).map(([id, body]) => [id, Ecliptic(GeoVector(body, date, true)).elon]),
  ) as Record<keyof typeof PLANETS, number>;
  return {
    sun,
    earth: normalizeDegrees(sun + 180),
    northNode: node,
    southNode: normalizeDegrees(node + 180),
    moon: EclipticGeoMoon(date).lon,
    ...planets,
  };
}

const DAY_MS = 86_400_000;
/** Средняя скорость Солнца, °/сутки: шаг итерации. */
const SUN_DEG_PER_DAY = 360 / 365.2422;

/**
 * Момент дизайна: Солнце ровно на 88° эклиптической долготы позади Солнца
 * рождения (около 88–89 суток раньше). Ньютон по долготе Солнца сходится
 * за 3–4 шага; 10 — с запасом.
 */
export function designDate(birth: Date): Date {
  const target = normalizeDegrees(SunPosition(birth).elon - 88);
  let t = birth.getTime() - (88 / SUN_DEG_PER_DAY) * DAY_MS;
  for (let i = 0; i < 10; i++) {
    let delta = normalizeDegrees(target - SunPosition(new Date(t)).elon);
    if (delta > 180) delta -= 360;
    t += (delta / SUN_DEG_PER_DAY) * DAY_MS;
    if (Math.abs(delta) < 1e-7) break;
  }
  return new Date(Math.round(t));
}
