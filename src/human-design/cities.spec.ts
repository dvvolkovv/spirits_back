const jestExpect = (globalThis as unknown as { expect: jest.Expect }).expect;
const expect = Object.assign(<T>(actual: T, _message?: string) => jestExpect(actual), jestExpect);
import { cityPlace, cityWithPlace, indexCities, normalize, searchCities, type City, type CityDb } from './cities';

const DB: CityDb = {
  v: 1,
  zones: ['Europe/Moscow', 'Europe/Berlin', 'Asia/Yekaterinburg'],
  countries: { RU: 'Россия', DE: 'Германия' },
  regions: ['Москва', 'Татарстан', 'Нижегородская область', 'Берлин'],
  cities: [
    ['Москва', 'Moscow', 'RU', 0, 10381, 0],
    ['Нижний Новгород', 'Nizhniy Novgorod', 'RU', 0, 1259, 2],
    ['Казань', 'Kazan', 'RU', 0, 1244, 1],
    ['Берлин', 'Berlin', 'DE', 1, 3426, 3],
    ['Великий Новгород', 'Velikiy Novgorod', 'RU', 0, 218, -1],
    ['Ёлкино', '', 'RU', 2, 20, -1],
    ['Zürich', 'Zurich', 'CH', 1, 341, -1],
  ],
};
const index = indexCities(DB);
const names = (q: string) => searchCities(index, q).map((c) => c.name);

describe('поиск города', () => {
  it('по началу названия, крупные первыми', () => {
    expect(names('каз')).toEqual(['Казань']);
    expect(names('Мо')).toEqual(['Москва']);
  });

  it('по началу слова — после совпадений с начала', () => {
    expect(names('нов')).toEqual(['Нижний Новгород', 'Великий Новгород']);
    expect(names('ниж')).toEqual(['Нижний Новгород']);
  });

  it('латиницей и без диакритики', () => {
    expect(names('kazan')).toEqual(['Казань']);
    expect(names('zur')).toEqual(['Zürich']);
  });

  it('ё и е не различаются, дефис — как пробел', () => {
    expect(names('елкино')).toEqual(['Ёлкино']);
    expect(normalize('Санкт-Петербург')).toBe('санкт петербург');
  });

  it('короче двух букв — ничего', () => {
    expect(names('к')).toEqual([]);
    expect(names('  ')).toEqual([]);
  });

  it('город несёт свой пояс и место', () => {
    const [kazan] = searchCities(index, 'казань');
    expect(kazan.zone).toBe('Europe/Moscow');
    expect(cityPlace(kazan)).toBe('Татарстан, Россия');
    // Регион совпал с названием — не повторяем: «Москва, Москва, Россия».
    expect(cityPlace(searchCities(index, 'москва')[0])).toBe('Россия');
    // Нет страны в справочнике — показываем код.
    expect(cityPlace(searchCities(index, 'zurich')[0])).toBe('CH');
  });

  it('не больше limit подсказок', () => {
    expect(searchCities(index, 'нов', 1)).toHaveLength(1);
  });
});

describe('место города на разных языках', () => {
  const beijing: City = { name: '北京', region: '北京市', country: '中国', zone: 'Asia/Shanghai' };
  const noRegion: City = { name: 'X', region: null, country: '中国', zone: 'Asia/Shanghai' };

  it('ru (и по умолчанию) — через запятую с пробелом', () => {
    const [kazan] = searchCities(index, 'казань');
    expect(cityPlace(kazan, 'ru')).toBe('Татарстан, Россия');
    expect(cityPlace(kazan)).toBe('Татарстан, Россия');
    expect(cityWithPlace(kazan, 'ru')).toBe('Казань (Татарстан, Россия)');
    expect(cityWithPlace(kazan)).toBe('Казань (Татарстан, Россия)');
  });

  it('ru без региона — только страна, латинские скобки с пробелом', () => {
    const [moscow] = searchCities(index, 'москва');
    expect(cityPlace(moscow, 'ru')).toBe('Россия');
    expect(cityWithPlace(moscow, 'ru')).toBe('Москва (Россия)');
  });

  it('zh — полноширинная запятая без пробела', () => {
    expect(cityPlace(beijing, 'zh')).toBe('北京市，中国');
  });

  it('zh без региона — только страна', () => {
    expect(cityPlace(noRegion, 'zh')).toBe('中国');
  });

  it('zh — полноширинные скобки без пробела перед ними', () => {
    expect(cityWithPlace(beijing, 'zh')).toBe('北京（北京市，中国）');
  });

  it('zh без региона — скобки вокруг одной страны', () => {
    expect(cityWithPlace(noRegion, 'zh')).toBe('X（中国）');
  });
});
