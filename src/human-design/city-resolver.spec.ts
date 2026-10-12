import { indexCities, type CityDb } from './cities';
import { DOMINANT_RATIO, MAX_CANDIDATES, resolveCity } from './city-resolver';

const DB: CityDb = {
  v: 1,
  zones: ['Europe/Moscow', 'Europe/Berlin'],
  countries: { RU: 'Россия', DE: 'Германия' },
  regions: ['Москва', 'Татарстан', 'Нижегородская область', 'Берлин', 'Мурманская область', 'Ленинградская область'],
  cities: [
    ['Москва', 'Moscow', 'RU', 0, 10381, 0],
    ['Нижний Новгород', 'Nizhniy Novgorod', 'RU', 0, 1259, 2],
    ['Казань', 'Kazan', 'RU', 0, 1244, 1],
    ['Берлин', 'Berlin', 'DE', 1, 3426, 3],
    ['Великий Новгород', 'Velikiy Novgorod', 'RU', 0, 218, -1],
    ['Кировск', 'Kirovsk', 'RU', 0, 27, 4],
    ['Кировск', 'Kirovsk', 'RU', 0, 26, 5],
  ],
};
const index = indexCities(DB);
const populations = DB.cities.map((c) => c[4]);

describe('город для инструмента Райи', () => {
  it('точное совпадение названия — берём, без регистра и латиницей', () => {
    expect(resolveCity(index, 'Казань')).toEqual({
      kind: 'found',
      cityId: 2,
      city: { name: 'Казань', region: 'Татарстан', country: 'Россия', zone: 'Europe/Moscow' },
    });
    expect(resolveCity(index, '  казань ')).toMatchObject({ kind: 'found', cityId: 2 });
    expect(resolveCity(index, 'Kazan')).toMatchObject({ kind: 'found', cityId: 2 });
  });

  it('одноимённых несколько — варианты, крупные первыми', () => {
    const r = resolveCity(index, 'Кировск');
    expect(r.kind).toBe('choose');
    if (r.kind !== 'choose') return;
    expect(r.candidates.map((c) => [c.cityId, c.region])).toEqual([
      [5, 'Мурманская область'],
      [6, 'Ленинградская область'],
    ]);
    expect(r.total).toBe(2);
  });

  it('регион сужает точно', () => {
    expect(resolveCity(index, 'Кировск, Ленинградская')).toMatchObject({ kind: 'found', cityId: 6 });
  });

  it('подсказка отфильтровала все совпадения — варианты без нее, но никогда found: пояс угадывать нельзя', () => {
    // У Москвы регион в базе — null (совпадает с названием города), поэтому
    // «Москва, Московская область» подсказкой не находится никогда — без
    // отката такой запрос вернул бы not_found для существующего города.
    expect(resolveCity(index, 'Москва, Московская область')).toEqual({
      kind: 'choose',
      candidates: [{ name: 'Москва', region: null, country: 'Россия', zone: 'Europe/Moscow', cityId: 0 }],
      total: 1,
    });
    // «Казань, Германия» — подсказка не подходит ни одному городу с таким
    // названием; откат без подсказки находит Казань, но вариантом, не found.
    expect(resolveCity(index, 'Казань, Германия')).toEqual({
      kind: 'choose',
      candidates: [{ name: 'Казань', region: 'Татарстан', country: 'Россия', zone: 'Europe/Moscow', cityId: 2 }],
      total: 1,
    });
  });

  it('не больше трёх подсказок после названия — хвост игнорируется, не ломает поиск', () => {
    const r = resolveCity(index, 'Казань, Татарстан, Россия, Татарстан, ерунда полная');
    expect(r).toMatchObject({ kind: 'found', cityId: 2 });
  });

  it('без точного совпадения — только варианты, даже если вариант один: пояс угадывать нельзя', () => {
    const r = resolveCity(index, 'Новгород');
    expect(r.kind === 'choose' && r.candidates.map((c) => c.name)).toEqual(['Нижний Новгород', 'Великий Новгород']);
    expect(resolveCity(index, 'Каз')).toMatchObject({ kind: 'choose', candidates: [{ cityId: 2, name: 'Казань' }] });
  });

  it('не найден, пусто, одна буква', () => {
    for (const q of ['Атлантида', '', 'К']) expect(resolveCity(index, q)).toEqual({ kind: 'not_found' });
  });

  it('cityId из прошлого ответа — берётся напрямую; чужой — не найден', () => {
    expect(resolveCity(index, 'что угодно', 3)).toMatchObject({
      kind: 'found',
      cityId: 3,
      city: { name: 'Берлин', zone: 'Europe/Berlin' },
    });
    for (const id of [999, -1, 1.5]) expect(resolveCity(index, 'Казань', id)).toEqual({ kind: 'not_found' });
  });

  it(`вариантов не больше ${MAX_CANDIDATES}, total — сколько было до обрезки`, () => {
    const many: CityDb = {
      ...DB,
      cities: Array.from({ length: 8 }, (_, i) => ['Кировск', 'Kirovsk', 'RU', 0, 100 - i, -1] as CityDb['cities'][number]),
    };
    const r = resolveCity(indexCities(many), 'Кировск');
    expect(r.kind === 'choose' && r.candidates).toHaveLength(MAX_CANDIDATES);
    expect(r.kind === 'choose' && r.total).toBe(8);
  });

  it(`явный перевес населения (×${DOMINANT_RATIO}+) среди одноимённых — берём крупный без уточнения`, () => {
    expect(DOMINANT_RATIO).toBe(20);
    // Два «Кировска» (27 и 26 тыс.) — перевес слишком мал, уточнение нужно всё равно.
    expect(resolveCity(index, 'Кировск', undefined, populations).kind).toBe('choose');

    const moscowDb: CityDb = {
      v: 1,
      zones: ['Europe/Moscow'],
      countries: { RU: 'Россия' },
      regions: ['Москва'],
      cities: [
        ['Москва', 'Moscow', 'RU', 0, 10381, 0],
        ['Москва', 'Moscow', 'RU', 0, 25, -1],
      ],
    };
    const moscowIndex = indexCities(moscowDb);
    const moscowPopulations = moscowDb.cities.map((c) => c[4]);
    expect(resolveCity(moscowIndex, 'Москва', undefined, moscowPopulations)).toMatchObject({ kind: 'found', cityId: 0 });
    // Без populations — прежнее поведение, уточнение.
    expect(resolveCity(moscowIndex, 'Москва').kind).toBe('choose');
  });

  it('подсказка отфильтровала всё, а среди тёзков — явный перевес населения: вариант один (не found, тёзку не подсовываем)', () => {
    const moscowDb: CityDb = {
      v: 1,
      zones: ['Europe/Moscow'],
      countries: { RU: 'Россия' },
      regions: ['Москва'],
      cities: [
        ['Москва', 'Moscow', 'RU', 0, 10381, 0],
        ['Москва', 'Moscow', 'RU', 0, 25, -1], // тёзка за рубежом — регион не 'Москва', не отфильтруется им самим
      ],
    };
    const moscowIndex = indexCities(moscowDb);
    const moscowPopulations = moscowDb.cities.map((c) => c[4]);
    // Подсказка «Московская область» отфильтровывает обе записи (у первой
    // регион — null, у второй region=-1 тоже null): откат без подсказки
    // находит обе, но доминирующую (в 20+ раз крупнее) отдаём одной —
    // списком из одного кандидата, а не found.
    const r = resolveCity(moscowIndex, 'Москва, Московская область', undefined, moscowPopulations);
    expect(r.kind).toBe('choose');
    if (r.kind !== 'choose') return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].cityId).toBe(0);
  });
});
