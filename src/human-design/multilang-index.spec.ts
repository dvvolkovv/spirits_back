import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMultilingualCities, multilingualCities, SITE_LANGUAGES } from './multilang-index';
import { resolveCity, type CityResolution } from './city-resolver';
import { indexCities, type City, type CityDb } from './cities';

/**
 * Настоящие базы data/cities.<код>.json: город для инструмента Райи
 * находится по названию на любом языке сайта, а подписи остаются русскими.
 */
const DATA = join(__dirname, 'data');
const load = (code: string) => JSON.parse(readFileSync(join(DATA, `cities.${code}.json`), 'utf8')) as CityDb;
const dbs = Object.fromEntries(SITE_LANGUAGES.map((c) => [c, load(c)])) as Record<string, CityDb>;
const m = loadMultilingualCities(DATA);
const found = (q: string) => resolveCity(m.index, q, undefined, m.populations, m);
/** «Мюнхен, Германия» — если найден сразу, иначе kind. */
const foundName = (q: string) => {
  const r = found(q);
  return r.kind === 'found' ? `${r.city.name}, ${r.city.country}` : r.kind;
};
const cities = (r: CityResolution): City[] =>
  r.kind === 'found' ? [r.city] : r.kind === 'choose' ? r.candidates : [];
const munich = m.index.findIndex(({ city }) => city.name === 'Мюнхен' && city.country === 'Германия');

describe('город по названию на любом языке сайта', () => {
  it('языки сайта — те же семь, что у калькулятора, и баз в data ровно столько', () => {
    expect([...SITE_LANGUAGES]).toEqual(['ru', 'en', 'es', 'de', 'fr', 'pt', 'zh']);
    const files = readdirSync(DATA).filter((f) => /^cities\..+\.json$/.test(f));
    expect(files.sort()).toEqual(SITE_LANGUAGES.map((c) => `cities.${c}.json`).sort());
  });

  it('Мюнхен — на пяти языках и иероглифами', () => {
    for (const q of ['Мюнхен', 'München', 'Munich', 'Múnich', 'Munique', '慕尼黑']) {
      expect([q, foundName(q)]).toEqual([q, 'Мюнхен, Германия']);
    }
  });

  it('Пекин — иероглифами и по-немецки; Севилья — по-французски и иероглифами', () => {
    expect(foundName('北京')).toBe('Пекин, Китай');
    expect(foundName('Peking')).toBe('Пекин, Китай');
    expect(foundName('Séville')).toBe('Севилья, Испания');
    expect(foundName('塞维利亚')).toBe('Севилья, Испания');
  });

  it('иероглифами — с «市» и без, слитно и через дефис', () => {
    expect(foundName('北京市')).toBe('Пекин, Китай');
    expect(foundName('上海市')).toBe('Шанхай, Китай');
    expect(foundName('重庆')).toBe('Чунцин, Китай');
    expect(foundName('广州')).toBe('Гуанчжоу, Китай');
    expect(foundName('克卢日-纳波卡')).toBe('Клуж-Напока, Румыния');
    expect(foundName('克卢日纳波卡')).toBe('Клуж-Напока, Румыния');
  });

  it('«Sevilla» — есть и в Колумбии (другой пояс): варианты, Испания первой; со страной — сразу', () => {
    const r = found('Sevilla');
    expect(r.kind).toBe('choose');
    expect(cities(r).map((c) => `${c.name}, ${c.country}`)).toEqual(['Севилья, Испания', 'Sevilla, Колумбия']);
    expect(foundName('Sevilla, España')).toBe('Севилья, Испания');
    expect(foundName('Sevilla, Colombia')).toBe('Sevilla, Колумбия');
  });

  it('подсказка региона и страны — на любом языке, через любую запятую', () => {
    const queries = [
      'München, Bayern',
      'Munich, Bavaria, Germany',
      'Мюнхен, Бавария',
      '慕尼黑, 德国',
      '慕尼黑，德国',
      '慕尼黑、德国',
      '慕尼黑；德国',
      'Munique, Alemanha',
    ];
    for (const q of queries) expect([q, foundName(q)]).toEqual([q, 'Мюнхен, Германия']);
  });

  it('подсказка — с начала слова, а не кусок внутри («us» — не «Massachusetts», не «Neuseeland»)', () => {
    const springfield = found('Springfield, US');
    expect(springfield.kind).toBe('choose');
    expect(cities(springfield).length).toBeGreaterThan(1);
    expect(cities(springfield).every((c) => c.country === 'США')).toBe(true);
    const cambridge = cities(found('Cambridge, US'));
    expect(cambridge.length).toBeGreaterThan(0);
    expect(cambridge.every((c) => c.country === 'США')).toBe(true);
  });

  it('страна кодом и обиходным сокращением', () => {
    expect(foundName('Chicago, USA')).toBe('Чикаго, США');
    const portland = found('Portland, Oregon, USA');
    expect(portland.kind === 'found' && [portland.city.name, portland.city.region]).toEqual(['Портленд', 'Орегон']);
    expect(foundName('Manchester, UK')).toBe('Манчестер, Британия');
    expect(foundName('Manchester, Великобритания')).toBe('Манчестер, Британия');
    expect(foundName('Dubai, UAE')).toBe('Дубай, ОАЭ');
    expect(foundName('Москва, РФ')).toBe('Москва, Россия');
    const canton = found('Canton, USA');
    expect(canton.kind).toBe('choose');
    expect(cities(canton).every((c) => c.country === 'США')).toBe(true);
  });

  it('«St.» — то же, что Saint/Sankt; без страны — варианты, со страной — сразу', () => {
    expect(foundName('St. Petersburg, Russia')).toBe('Санкт-Петербург, Россия');
    const bare = found('St. Petersburg');
    expect(bare.kind).toBe('choose');
    expect(cities(bare).map((c) => c.country)).toEqual(expect.arrayContaining(['Россия', 'США']));
  });

  it('чужое название крупного города против своего у малого — варианты, а не крупный сразу', () => {
    // «Vienne» — Вена по-французски и город Вьенн во Франции; «Sidney» — Сидней
    // по-испански и Сидней в Огайо; «Colonia» — Кёльн по-испански и Колониа в США.
    const cases: [string, string[]][] = [
      ['Vienne', ['Вена, Австрия', 'Вьенн, Франция']],
      ['Sidney', ['Сидней, Австралия', 'Сидней, США']],
      ['Colonia', ['Кёльн, Германия', 'Колониа, США']],
      ['Mombaça', ['Момбаса, Кения', 'Mombaça, Бразилия']],
      ['Mexico', ['Мехико, Мексика', 'Mexico, Филиппины']],
    ];
    for (const [q, expected] of cases) {
      const r = found(q);
      expect([q, r.kind]).toEqual([q, 'choose']);
      expect(cities(r).map((c) => `${c.name}, ${c.country}`)).toEqual(expect.arrayContaining(expected));
    }
  });

  it('свои названия — перевес населения работает, как раньше', () => {
    expect(foundName('Пекин')).toBe('Пекин, Китай');
    expect(foundName('Сидней')).toBe('Сидней, Австралия');
    expect(foundName('Москва')).toBe('Москва, Россия');
  });

  it('неоднозначность — по-прежнему варианты', () => {
    expect(found('Железногорск').kind).toBe('choose');
  });

  it('подписи — русские, как раньше', () => {
    const r = found('München');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.city).toEqual({ name: 'Мюнхен', region: 'Бавария', country: 'Германия', zone: 'Europe/Berlin' });
    }
  });
});

describe('общий указатель семи баз', () => {
  const fromDbs = (over: Partial<Record<string, CityDb>> = {}) => multilingualCities((c) => (c in over ? over[c] : dbs[c])!);

  it('базы берутся по одной, русская первой', () => {
    const order: string[] = [];
    multilingualCities((c) => {
      order.push(c);
      return dbs[c];
    });
    expect(order).toEqual([...SITE_LANGUAGES]);
  });

  it('разная длина или нет базы — ошибка', () => {
    expect(() => fromDbs({ en: { ...dbs.en, cities: dbs.en.cities.slice(1) } })).toThrow('база городов en');
    expect(() =>
      multilingualCities((c) => {
        if (c === 'pt') throw new Error('нет файла');
        return dbs[c];
      }),
    ).toThrow();
  });

  it('строки переставлены при той же длине — тоже ошибка', () => {
    const swapped = [...dbs.de.cities];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(() => fromDbs({ de: { ...dbs.de, cities: swapped } })).toThrow('база городов de');
  });

  it('все ключи, что дал бы indexCities на любом языке, — в общем указателе', () => {
    for (const code of SITE_LANGUAGES) {
      const missing: string[] = [];
      indexCities(dbs[code]).forEach(({ keys }, i) => {
        for (const k of keys) if (!m.index[i].keys.includes(k)) missing.push(`${code}#${i}: ${k}`);
      });
      expect(missing.slice(0, 5)).toEqual([]);
    }
  });

  it('собственные названия — первыми: русское и латиница GeoNames; ключи без повторов', () => {
    expect(munich).toBeGreaterThanOrEqual(0);
    const { keys } = m.index[munich];
    expect(keys.slice(0, m.ownKeys[munich])).toEqual(['мюнхен', 'munich']);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['munchen', 'munique', '慕尼黑', '慕尼黑市']));
  });

  it('места — на всех языках, с кодом страны; одинаковые места не дублируются', () => {
    expect(m.places[munich].split(' ')).toEqual(
      expect.arrayContaining(['бавария', 'германия', 'bayern', 'deutschland', 'bavaria', 'germany', 'de']),
    );
    expect(m.places).toHaveLength(dbs.ru.cities.length);
    expect(m.populations).toHaveLength(dbs.ru.cities.length);
    expect(m.ownKeys).toHaveLength(dbs.ru.cities.length);
    expect(new Set(m.places).size).toBeLessThan(m.places.length / 5);
  });

  it('базы не меняются', () => {
    const before = JSON.stringify(dbs.ru.cities.slice(0, 1000));
    fromDbs();
    expect(JSON.stringify(dbs.ru.cities.slice(0, 1000))).toBe(before);
  });
});
