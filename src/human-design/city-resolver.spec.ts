import { indexCities, type CityDb } from './cities';
import { MAX_CANDIDATES, resolveCity } from './city-resolver';

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
  });

  it('регион или страна после запятой сужают', () => {
    expect(resolveCity(index, 'Кировск, Ленинградская')).toMatchObject({ kind: 'found', cityId: 6 });
    expect(resolveCity(index, 'Казань, Германия')).toEqual({ kind: 'not_found' });
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

  it(`вариантов не больше ${MAX_CANDIDATES}`, () => {
    const many: CityDb = {
      ...DB,
      cities: Array.from({ length: 8 }, (_, i) => ['Кировск', 'Kirovsk', 'RU', 0, 100 - i, -1] as CityDb['cities'][number]),
    };
    const r = resolveCity(indexCities(many), 'Кировск');
    expect(r.kind === 'choose' && r.candidates).toHaveLength(MAX_CANDIDATES);
  });
});
