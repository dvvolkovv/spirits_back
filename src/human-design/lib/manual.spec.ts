const expect = Object.assign((actual: unknown, _message?: string) => globalThis.expect(actual), globalThis.expect) as typeof globalThis.expect;
import { calculateChart } from './chart';
import { HD_AUTHORITIES, HD_TYPES, type HdAuthority, type HdDefinition, type HdType } from './rules';

/**
 * Карты ручной сверки (спека, «Точность»). Эталон Swiss Ephemeris колесо ворот
 * и правила типа, авторитета, профиля и определённости не проверяет — у него
 * та же таблица. Эти десять карт посчитаны на двух независимых калькуляторах
 * каждая; подобраны scripts/hd-pick-manual.ts так, чтобы встретились все
 * типы, авторитеты и виды определённости. Данные рождения вымышленные.
 */
interface ManualChart {
  date: string;
  time: string;
  zone: string;
  expect: { type: HdType; authority: HdAuthority; profile: string; definition: HdDefinition; channels: string[] };
  /** Где сверено: два калькулятора, не наш код. */
  checkedWith: string[];
}

/** Когда сверено. */
const CHECKED_AT = '2026-10-08';

const MANUAL: ManualChart[] = [
  {
    date: '1990-03-12', time: '14:25', zone: 'Europe/Moscow',
    expect: { type: 'manifestor', authority: 'emotional', profile: '5/2', definition: 'single',
      channels: ['7-31', '12-22'] },
    // вводить: Москва, 1990-03-12 14:25 (UTC+3); Солнце личности 22.5, дизайна 11.2
    checkedWith: ['bodygraph.io', 'astrolium.com'],
  },
  {
    date: '1950-06-30', time: '02:48', zone: 'Asia/Novosibirsk',
    expect: { type: 'manifestingGenerator', authority: 'sacral', profile: '4/6', definition: 'split',
      channels: ['18-58', '20-57', '29-46'] },
    // вводить: Новосибирск, 1950-06-30 02:48 (UTC+7); Солнце личности 52.4, дизайна 17.6
    checkedWith: ['bodygraph.io', 'astrolium.com'],
  },
  {
    date: '2010-03-20', time: '14:01', zone: 'America/New_York',
    expect: { type: 'projector', authority: 'splenic', profile: '2/5', definition: 'triple',
      channels: ['4-63', '11-56', '17-62', '18-58', '25-51'] },
    // вводить: New York, 2010-03-20 14:01 (UTC-4); Солнце личности 25.2, дизайна 10.5
    checkedWith: ['bodygraph.io', 'astrolium.com'],
  },
  {
    date: '1955-01-11', time: '22:04', zone: 'Europe/Berlin',
    expect: { type: 'reflector', authority: 'lunar', profile: '1/3', definition: 'none',
      channels: [] },
    // вводить: Berlin, 1955-01-11 22:04 (UTC+1); Солнце личности 61.1, дизайна 32.3
    checkedWith: ['bodygraph.io', 'astrolium.com'],
  },
  {
    date: '1951-05-28', time: '09:25', zone: 'Asia/Tokyo',
    expect: { type: 'generator', authority: 'emotional', profile: '1/3', definition: 'quadruple',
      channels: ['9-52', '20-57', '37-40', '47-64'] },
    // вводить: Tokyo, 1951-05-28 09:25 (UTC+10); Солнце личности 16.1, дизайна 37.3
    checkedWith: ['bodygraph.io', 'astrolium.com'],
  },
  {
    date: '2006-11-12', time: '17:30', zone: 'Asia/Tokyo',
    expect: { type: 'projector', authority: 'selfProjected', profile: '1/4', definition: 'single',
      channels: ['4-63', '7-31', '23-43'] },
    // вводить: Tokyo, 2006-11-12 17:30 (UTC+9); Солнце личности 43.1, дизайна 4.4
    checkedWith: ['bodygraph.io', 'astrolium.com'],
  },
  {
    date: '1953-08-06', time: '10:22', zone: 'America/New_York',
    expect: { type: 'manifestor', authority: 'ego', profile: '1/3', definition: 'single',
      channels: ['1-8', '7-31', '21-45'] },
    // вводить: New York, 1953-08-06 10:22 (UTC-4); Солнце личности 7.1, дизайна 2.3
    checkedWith: ['bodygraph.io', 'astrolium.com'],
  },
  {
    date: '1991-11-01', time: '16:25', zone: 'Asia/Tokyo',
    expect: { type: 'projector', authority: 'mental', profile: '1/3', definition: 'single',
      channels: ['47-64'] },
    // вводить: Tokyo, 1991-11-01 16:25 (UTC+9); Солнце личности 44.1, дизайна 33.3
    checkedWith: ['bodygraph.io', 'astrolium.com'],
  },
  {
    date: '1984-01-11', time: '20:06', zone: 'Europe/Moscow',
    expect: { type: 'generator', authority: 'sacral', profile: '6/3', definition: 'single',
      channels: ['32-54', '42-53'] },
    // вводить: Москва, 1984-01-11 20:06 (UTC+3); Солнце личности 54.6, дизайна 32.3
    checkedWith: ['bodygraph.io', 'astrolium.com'],
  },
  {
    date: '1952-12-17', time: '05:30', zone: 'Asia/Novosibirsk',
    expect: { type: 'generator', authority: 'sacral', profile: '3/5', definition: 'single',
      channels: ['34-57'] },
    // вводить: Новосибирск, 1952-12-17 05:30 (UTC+7); Солнце личности 11.3, дизайна 6.5
    checkedWith: ['bodygraph.io', 'astrolium.com'],
  },
];

describe(`карты ручной сверки (${CHECKED_AT})`, () => {
  it('десять карт: все типы, все авторитеты, каждая сверена дважды', () => {
    expect(MANUAL).toHaveLength(10);
    expect(new Set(MANUAL.map((m) => m.expect.type))).toEqual(new Set(HD_TYPES));
    expect(new Set(MANUAL.map((m) => m.expect.authority))).toEqual(new Set(HD_AUTHORITIES));
    for (const m of MANUAL) expect(m.checkedWith.length, `${m.date} ${m.time}`).toBeGreaterThanOrEqual(2);
  });

  for (const m of MANUAL) {
    it(`${m.date} ${m.time} ${m.zone}`, () => {
      const r = calculateChart({ date: m.date, time: m.time, zone: m.zone });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      const { type, authority, profile, definition, channels } = r.chart;
      expect({ type, authority, profile, definition, channels }).toEqual(m.expect);
    });
  }
});
