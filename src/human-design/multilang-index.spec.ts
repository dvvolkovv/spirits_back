import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { multilingualCities, SITE_LANGUAGES } from './multilang-index';
import { resolveCity } from './city-resolver';
import type { CityDb } from './cities';

/**
 * Настоящие базы data/cities.<код>.json: город для инструмента Райи
 * находится по названию на любом языке сайта, а подписи остаются русскими.
 */
const load = (code: string) => JSON.parse(readFileSync(join(__dirname, 'data', `cities.${code}.json`), 'utf8')) as CityDb;
const dbs = Object.fromEntries(SITE_LANGUAGES.map((c) => [c, load(c)])) as Record<string, CityDb>;
const { index, places, populations } = multilingualCities(dbs);
const found = (q: string) => resolveCity(index, q, undefined, populations, places);
const foundName = (q: string) => {
  const r = found(q);
  return r.kind === 'found' ? r.city.name : r.kind;
};

describe('город по названию на любом языке сайта', () => {
  it('языки сайта — те же семь, что у калькулятора', () => {
    expect([...SITE_LANGUAGES]).toEqual(['ru', 'en', 'es', 'de', 'fr', 'pt', 'zh']);
  });

  it('Мюнхен — на четырёх языках и иероглифами', () => {
    for (const q of ['Мюнхен', 'München', 'Munich', 'Múnich', 'Munique', '慕尼黑']) {
      const r = found(q);
      expect(r.kind).toBe('found');
      if (r.kind === 'found') expect([q, r.city.name, r.city.zone]).toEqual([q, 'Мюнхен', 'Europe/Berlin']);
    }
  });

  it('Пекин — иероглифами и по-немецки; Севилья — по-французски', () => {
    expect(foundName('北京')).toBe('Пекин');
    expect(foundName('Peking')).toBe('Пекин');
    expect(foundName('Séville')).toBe('Севилья');
    expect(foundName('塞维利亚')).toBe('Севилья');
  });

  it('«Sevilla» — есть и в Колумбии (другой пояс): варианты, Испания первой; со страной — сразу', () => {
    const r = found('Sevilla');
    expect(r.kind).toBe('choose');
    if (r.kind === 'choose') {
      expect(r.candidates.map((c) => [c.name, c.country])).toEqual([
        ['Севилья', 'Испания'],
        ['Sevilla', 'Колумбия'],
      ]);
    }
    expect(foundName('Sevilla, España')).toBe('Севилья');
    expect(foundName('Sevilla, Colombia')).toBe('Sevilla');
  });

  it('подсказка региона и страны — на любом языке', () => {
    // «，» — китайская запятая: так регион допишет и человек, пишущий иероглифами.
    for (const q of ['München, Bayern', 'Munich, Bavaria, Germany', 'Мюнхен, Бавария', '慕尼黑, 德国', '慕尼黑，德国', 'Munique, Alemanha']) {
      expect([q, foundName(q)]).toEqual([q, 'Мюнхен']);
    }
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

  it('семь баз согласованы — иначе ошибка', () => {
    const broken = { ...dbs, en: { ...dbs.en, cities: dbs.en.cities.slice(1) } };
    expect(() => multilingualCities(broken)).toThrow();
    const { en, ...withoutEn } = dbs;
    expect(en).toBeDefined();
    expect(() => multilingualCities(withoutEn)).toThrow();
  });

  it('строки переставлены при той же длине — тоже ошибка', () => {
    const swapped = [...dbs.de.cities];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(() => multilingualCities({ ...dbs, de: { ...dbs.de, cities: swapped } })).toThrow('база городов de');
  });

  it('базы не меняются: указатель строится заново, ключи без повторов', () => {
    const before = JSON.stringify(dbs.ru.cities[327]);
    const again = multilingualCities(dbs);
    expect(JSON.stringify(dbs.ru.cities[327])).toBe(before);
    const keys = again.index[327].keys;
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['мюнхен', 'munich', 'munchen', 'munique', '慕尼黑']));
    expect(again.populations).toHaveLength(dbs.ru.cities.length);
    expect(again.places).toHaveLength(dbs.ru.cities.length);
  });
});
