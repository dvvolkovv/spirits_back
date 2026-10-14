import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexCities, normalize, type CityDb, type CityIndex } from './cities';

/** Языки сайта: базы городов — data/cities.<код>.json, один список и порядок городов. */
export const SITE_LANGUAGES = ['ru', 'en', 'es', 'de', 'fr', 'pt', 'zh'] as const;
export type SiteLanguage = (typeof SITE_LANGUAGES)[number];

/**
 * Обиходные сокращения стран — к названиям на семи языках и коду ISO
 * (он тоже в местах: «Springfield, US»). Только однозначные: «England» или
 * «Holland» — часть страны, а не она сама, их нет.
 */
export const COUNTRY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  US: ['usa', 'сша'],
  GB: ['uk', 'великобритания'],
  AE: ['uae', 'оаэ'],
  RU: ['рф'],
};

export interface MultilingualCities {
  /** Подписи — русские (база ru), ключи поиска — названия на всех языках и латиница. */
  index: CityIndex;
  /**
   * «Регион страна» на всех языках, код страны и сокращения — нормализованная
   * строка через пробел, для подсказок после запятой (сверяются с начала
   * слова). Одинаковые строки — один и тот же объект.
   */
  places: string[];
  /** Население в тыс. — для перевеса среди одноимённых. */
  populations: number[];
  /**
   * Сколько первых ключей index[i].keys — собственные названия города:
   * русское и латиница GeoNames. Дальше — названия на других языках и
   * производные («St.», «市»): по ним крупный город не перевешивает малый,
   * совпавший своим названием (Vienne — Вена по-французски и город во Франции).
   */
  ownKeys: Uint8Array;
}

type Row = CityDb['cities'][number];

/** Латиница GeoNames (или само название, если оно и есть латиница) — общая для всех языков. */
const latinOf = (row: Row) => (row[1] || row[0]).toLowerCase();

/** Места одной базы: разные «регион страна» (нормализованные) и номер места у каждой записи. */
interface PlaceParts {
  texts: string[];
  ids: Uint32Array;
}

/**
 * «Регион страна» на языке базы — как подпись indexCities (регион, равный
 * названию города, опускается). Разных мест — тысячи на десятки тысяч
 * городов: каждое нормализуется и хранится один раз.
 */
function placeParts(db: CityDb): PlaceParts {
  const byKey = new Map<string, number>();
  const texts: string[] = [];
  const ids = new Uint32Array(db.cities.length);
  db.cities.forEach(([name, , cc, , , region], i) => {
    const r = region >= 0 && db.regions[region] !== name ? region : -1;
    const key = `${r}|${cc}`;
    let id = byKey.get(key);
    if (id === undefined) {
      id = texts.length;
      texts.push(normalize(`${r >= 0 ? db.regions[r] : ''} ${db.countries[cc] ?? cc}`));
      byKey.set(key, id);
    }
    ids[i] = id;
  });
  return { texts, ids };
}

const HAN = /\p{Script=Han}/u;

/**
 * Китайские варианты названия: слитно (дефис и «·» после normalize — пробел,
 * а пишут и без них: 克卢日纳波卡) и в паре с «市» и без («北京» ↔ «北京市»,
 * «重庆市» ↔ «重庆»; без «市» — только если остаётся хотя бы два знака).
 */
function zhVariants(key: string): string[] {
  if (!HAN.test(key)) return [];
  const solid = key.replace(/ /g, '');
  const out = solid === key ? [] : [solid];
  if (!solid.endsWith('市')) out.push(`${solid}市`);
  else if (solid.length - 1 >= 2) out.push(solid.slice(0, -1));
  return out;
}

/** «St. Petersburg» — то же, что Saint/Sankt Petersburg; «Ste» — Sainte. */
const SAINT: Readonly<Record<string, string>> = { saint: 'st', sankt: 'st', sainte: 'ste' };
const SAINT_WORD = /(^| )(saint|sankt|sainte)( |$)/;
function saintVariant(key: string): string | null {
  if (!SAINT_WORD.test(key)) return null;
  return key
    .split(' ')
    .map((w) => SAINT[w] ?? w)
    .join(' ');
}

function addKey(keys: string[], k: string) {
  if (k && !keys.includes(k)) keys.push(k);
}

/** То, что от русской базы нужно для сверки других: без самих разобранных строк JSON. */
interface RuRow {
  cc: string;
  zone: string;
  population: number;
  latin: string;
}

interface Building {
  index: CityIndex;
  ownKeys: Uint8Array;
  rows: RuRow[];
  /** Места на уже пройденных языках — складываются в places в конце. */
  places: PlaceParts[];
}

/** Отдельной функцией — чтобы разобранная русская база не жила до конца сборки. */
function fromRu(ru: CityDb): Building {
  const index = indexCities(ru);
  return {
    index,
    ownKeys: Uint8Array.from(index, ({ keys }) => keys.length),
    rows: ru.cities.map((row) => ({ cc: row[2], zone: ru.zones[row[3]], population: row[4], latin: latinOf(row) })),
    places: [placeParts(ru)],
  };
}

/** Ключи и места одного языка — в общий указатель; база после вызова больше не нужна. */
function merge(b: Building, code: SiteLanguage, db: CityDb) {
  if (!db || db.cities.length !== b.rows.length) {
    throw new Error(`база городов ${code}: ${db?.cities?.length ?? 0} строк, в ru — ${b.rows.length}`);
  }
  db.cities.forEach((row, i) => {
    const own = b.rows[i];
    if (row[2] !== own.cc || db.zones[row[3]] !== own.zone || row[4] !== own.population || latinOf(row) !== own.latin) {
      throw new Error(`база городов ${code}: строка ${i} — другой город, чем в ru`);
    }
    // Ключи — как у indexCities: название и латиница. Латиница сверена выше
    // с русской базой, её ключ уже есть — нужно только название на языке.
    const keys = b.index[i].keys;
    const name = normalize(row[0]);
    addKey(keys, name);
    if (code === 'zh') for (const k of zhVariants(name)) addKey(keys, k);
  });
  b.places.push(placeParts(db));
}

/**
 * Общий указатель для инструмента Райи: город находится по названию на любом
 * из семи языков сайта («München», «Munich», «Мюнхен», «慕尼黑»), а подписи
 * остаются русскими — Райя называет их человеку на его языке. Строка N — один
 * и тот же город во всех базах (собраны одним прогоном build-hd-cities.py);
 * расхождение — страна, пояс, население или латиница не те, другая длина,
 * базы нет — ошибка: склеить разные города под одной подписью хуже, чем
 * отказать.
 *
 * Базы берутся по одной (load — по коду языка, ru первой), и от каждой в
 * памяти остаются только новые ключи и места: семь разобранных JSON разом —
 * лишние мегабайты на пике.
 */
export function multilingualCities(load: (code: SiteLanguage) => CityDb): MultilingualCities {
  const b = fromRu(load('ru'));
  for (const code of SITE_LANGUAGES) if (code !== 'ru') merge(b, code, load(code));

  // Одинаковые места (города того же региона) — одна строка на всех.
  const interned = new Map<string, string>();
  const places = b.rows.map(({ cc }, i) => {
    let key = '';
    for (const p of b.places) key += `${p.ids[i]},`;
    let place = interned.get(key);
    if (place === undefined) {
      place = [...b.places.map((p) => p.texts[p.ids[i]]), normalize(cc), ...(COUNTRY_ALIASES[cc] ?? [])].join(' ');
      interned.set(key, place);
    }
    return place;
  });
  for (const { keys } of b.index) {
    for (let j = 0, n = keys.length; j < n; j++) {
      const st = saintVariant(keys[j]);
      if (st) addKey(keys, st);
    }
  }
  return { index: b.index, places, populations: b.rows.map((r) => r.population), ownKeys: b.ownKeys };
}

/** Семь баз из каталога (data рядом со сборкой) — по одной за раз. */
export function loadMultilingualCities(dir: string): MultilingualCities {
  return multilingualCities((code) => JSON.parse(readFileSync(join(dir, `cities.${code}.json`), 'utf8')) as CityDb);
}
