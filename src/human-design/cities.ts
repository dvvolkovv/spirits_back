/**
 * Города для поля «Город рождения». Город нужен только ради часового пояса:
 * в формулы Human Design входит лишь момент рождения в UTC.
 *
 * База на каждый язык сайта — src/content/hd/cities.<код>.json, их собирает
 * scripts/build-hd-cities.py за один прогон из GeoNames (cities15000 +
 * названия на языке файла из alternateNamesV2, CC BY 4.0); строка N — один и
 * тот же город во всех базах. Записи отсортированы по населению — первые
 * совпадения и есть самые вероятные.
 */
export interface CityDb {
  v: 1;
  zones: string[];
  /** Код страны → название на языке файла. */
  countries: Record<string, string>;
  regions: string[];
  /** [название, латиницей или '', код страны, индекс пояса, население в тыс., индекс региона или -1] */
  cities: [string, string, string, number, number, number][];
}

export interface City {
  name: string;
  region: string | null;
  country: string;
  zone: string;
}

interface Indexed {
  city: City;
  /** Нормализованное название и написание латиницей. */
  keys: string[];
}

export type CityIndex = Indexed[];

/** Без регистра, ё/й и диакритики, любые разделители — один пробел. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function indexCities(db: CityDb): CityIndex {
  return db.cities.map(([name, latin, cc, zone, , region]) => ({
    city: {
      name,
      region: region >= 0 && db.regions[region] !== name ? db.regions[region] : null,
      country: db.countries[cc] ?? cc,
      zone: db.zones[zone],
    },
    keys: latin ? [normalize(name), normalize(latin)] : [normalize(name)],
  }));
}

/**
 * Подсказки: сначала города, чьё название начинается с запроса, потом — где с
 * запроса начинается слово («новгород» → Нижний Новгород). Порядок внутри —
 * по населению. Короче двух букв — ничего: подсказок были бы тысячи.
 */
export function searchCities(index: CityIndex, query: string, limit = 8): City[] {
  const q = normalize(query);
  if (q.length < 2) return [];
  const starts: City[] = [];
  const words: City[] = [];
  for (const { city, keys } of index) {
    if (keys.some((k) => k.startsWith(q))) {
      starts.push(city);
      if (starts.length >= limit) break;
    } else if (words.length < limit && keys.some((k) => k.includes(` ${q}`))) {
      words.push(city);
    }
  }
  return [...starts, ...words].slice(0, limit);
}

/** «Татарстан, Россия» — для подсказки под названием. */
export function cityPlace(city: City): string {
  return city.region ? `${city.region}, ${city.country}` : city.country;
}
