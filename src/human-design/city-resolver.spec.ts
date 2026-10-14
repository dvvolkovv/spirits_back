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

  it('подсказка — после любой запятой: «,», «，», «、», «；»', () => {
    for (const q of ['Кировск，Ленинградская', 'Кировск、Ленинградская', 'Кировск；Ленинградская']) {
      expect([q, resolveCity(index, q)]).toMatchObject([q, { kind: 'found', cityId: 6 }]);
    }
  });

  it('подсказка — с начала слова: кусок внутри слова не сужает', () => {
    // «градская» — внутри «Ленинградская», но не начало слова: подсказка не
    // подходит никому, откат без неё — оба Кировска вариантами.
    expect(resolveCity(index, 'Кировск, градская')).toMatchObject({ kind: 'choose', total: 2 });
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

describe('общий указатель: места на всех языках и собственные названия', () => {
  /** Вена по-французски — Vienne; во Франции есть свой город Вьенн (Vienne). */
  const WORLD: CityDb = {
    v: 1,
    zones: ['Europe/Vienna', 'America/Chicago', 'America/New_York', 'Europe/Paris'],
    countries: { AT: 'Австрия', US: 'США', FR: 'Франция' },
    regions: ['Миссури', 'Массачусетс', 'Овернь — Рона — Альпы'],
    cities: [
      ['Вена', 'Vienna', 'AT', 0, 1691, -1],
      ['Спрингфилд', 'Springfield', 'US', 1, 169, 0],
      ['Спрингфилд', 'Springfield', 'US', 2, 155, 1],
      ['Вьенн', 'Vienne', 'FR', 3, 29, 2],
    ],
  };
  const world = () => {
    const idx = indexCities(WORLD);
    idx[0].keys.push('vienne'); // название на другом языке — после собственных
    return idx;
  };
  const pops = WORLD.cities.map((c) => c[4]);
  const places = ['vienna austria at', 'missouri united states us', 'massachusetts united states us', 'auvergne rhone alpes france fr'];
  const ownKeys = [2, 2, 2, 2];

  it('подсказка по places — с начала слова, на любом языке', () => {
    const idx = world();
    expect(resolveCity(idx, 'Springfield, mass', undefined, pops, { places })).toMatchObject({ kind: 'found', cityId: 2 });
    expect(resolveCity(idx, 'Springfield，Missouri', undefined, pops, { places })).toMatchObject({ kind: 'found', cityId: 1 });
    expect(resolveCity(idx, 'Springfield, united states', undefined, pops, { places })).toMatchObject({ kind: 'choose', total: 2 });
    // «sett» — внутри «massachusetts», не начало слова: откат без подсказки, оба вариантами.
    expect(resolveCity(idx, 'Springfield, sett', undefined, pops, { places })).toMatchObject({ kind: 'choose', total: 2 });
    // Русские подписи без places подсказку по-английски не узнают.
    expect(resolveCity(idx, 'Springfield, mass', undefined, pops)).toMatchObject({ kind: 'choose', total: 2 });
  });

  it('крупный город совпал чужим названием, малый — своим: варианты, а не крупный сразу', () => {
    const r = resolveCity(world(), 'Vienne', undefined, pops, { places, ownKeys });
    expect(r.kind === 'choose' && r.candidates.map((c) => c.name)).toEqual(['Вена', 'Вьенн']);
    // Без сведений о собственных названиях — прежний перевес населения.
    expect(resolveCity(world(), 'Vienne', undefined, pops, { places })).toMatchObject({ kind: 'found', cityId: 0 });
    // Своим названием крупный находится сразу.
    expect(resolveCity(world(), 'Vienna', undefined, pops, { places, ownKeys })).toMatchObject({ kind: 'found', cityId: 0 });
  });
});

describe('подсказка: сначала целым словом, потом началом слова', () => {
  /** Мадрид в Испании (Comunidad de Madrid) и в Колумбии (CO). */
  const MADRIDS: CityDb = {
    v: 1,
    zones: ['Europe/Madrid', 'America/Bogota'],
    countries: { ES: 'Испания', CO: 'Колумбия' },
    regions: ['Область Мадрид', 'Кундинамарка'],
    cities: [
      ['Мадрид', 'Madrid', 'ES', 0, 3255, 0],
      ['Мадрид', 'Madrid', 'CO', 1, 80, 1],
    ],
  };
  const idx = indexCities(MADRIDS);
  const pops = MADRIDS.cities.map((c) => c[4]);
  const places = ['область мадрид испания comunidad de madrid spain es', 'кундинамарка колумбия cundinamarca colombia co'];
  const r = (q: string) => resolveCity(idx, q, undefined, pops, { places });

  it('код страны целым словом — не начало чужого слова', () => {
    expect(r('Madrid, CO')).toMatchObject({ kind: 'found', cityId: 1 });
    expect(r('Madrid, ES')).toMatchObject({ kind: 'found', cityId: 0 });
    expect(r('Madrid, comunidad')).toMatchObject({ kind: 'found', cityId: 0 });
  });

  it('целым словом не подходит никто — по началу слова', () => {
    expect(r('Madrid, cundi')).toMatchObject({ kind: 'found', cityId: 1 });
    expect(r('Madrid, comun')).toMatchObject({ kind: 'found', cityId: 0 });
  });

  it('без places — так же по русским подписям', () => {
    expect(resolveCity(index, 'Кировск, Мурманская область')).toMatchObject({ kind: 'found', cityId: 5 });
    expect(resolveCity(index, 'Кировск, Мурм')).toMatchObject({ kind: 'found', cityId: 5 });
  });
});
