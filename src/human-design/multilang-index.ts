import { indexCities, normalize, type City, type CityDb, type CityIndex } from './cities';

/** Языки сайта: базы городов — data/cities.<код>.json, один список и порядок городов. */
export const SITE_LANGUAGES = ['ru', 'en', 'es', 'de', 'fr', 'pt', 'zh'] as const;

export interface MultilingualCities {
  /** Подписи — русские (база ru), ключи поиска — названия на всех языках и латиница. */
  index: CityIndex;
  /** «Регион страна» на всех языках, нормализованное, — для подсказок после запятой. */
  places: string[];
  /** Население в тыс. — для перевеса среди одноимённых. */
  populations: number[];
}

type Row = CityDb['cities'][number];

/** Латиница GeoNames (или само название, если оно и есть латиница) — общая для всех языков. */
const latinOf = (row: Row) => (row[1] || row[0]).toLowerCase();

const placeOf = (city: City) => normalize(`${city.region ?? ''} ${city.country}`);

/**
 * Общий указатель для инструмента Райи: город находится по названию на любом
 * из семи языков сайта («München», «Munich», «Мюнхен», «慕尼黑»), а подписи
 * остаются русскими — Райя называет их человеку на его языке. Строка N — один
 * и тот же город во всех базах (собраны одним прогоном build-hd-cities.py);
 * расхождение — страна, пояс, население или латиница не те, другая длина,
 * базы нет — ошибка: склеить разные города под одной подписью хуже, чем
 * отказать.
 */
export function multilingualCities(dbs: Record<string, CityDb>): MultilingualCities {
  const ru = dbs.ru;
  if (!ru) throw new Error('нет базы городов ru');
  const index = indexCities(ru);
  const places = index.map(({ city }) => placeOf(city));
  for (const code of SITE_LANGUAGES) {
    if (code === 'ru') continue;
    const db = dbs[code];
    if (!db) throw new Error(`нет базы городов ${code}`);
    if (db.cities.length !== ru.cities.length) {
      throw new Error(`база городов ${code}: ${db.cities.length} строк, в ru — ${ru.cities.length}`);
    }
    db.cities.forEach((row, i) => {
      const own = ru.cities[i];
      if (
        row[2] !== own[2] ||
        db.zones[row[3]] !== ru.zones[own[3]] ||
        row[4] !== own[4] ||
        latinOf(row) !== latinOf(own)
      ) {
        throw new Error(`база городов ${code}: строка ${i} — другой город, чем в ru`);
      }
    });
    // Указатель — свежий, свой на каждый вызов: дописывать в его ключи безопасно.
    indexCities(db).forEach(({ city, keys }, i) => {
      const own = index[i].keys;
      for (const k of keys) if (!own.includes(k)) own.push(k);
      places[i] += ` ${placeOf(city)}`;
    });
  }
  return { index, places, populations: ru.cities.map((c) => c[4]) };
}
