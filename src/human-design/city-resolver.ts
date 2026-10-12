import { normalize, type City, type CityIndex } from './cities';

export const MAX_CANDIDATES = 5;

/**
 * Среди нескольких городов с одинаковым названием — если у самого крупного
 * населения хотя бы во столько раз больше, чем у второго, берём его без
 * уточнения («Москва» почти всегда значит Москву, а не тёзку за рубежом).
 */
export const DOMINANT_RATIO = 20;

/** Не больше трёх подсказок после названия (регион, страна — дальше явно мусор в запросе). */
const MAX_HINTS = 3;

/** Вариант для уточнения: cityId — номер записи в базе, им Райя отвечает при повторном вызове. */
export interface CityCandidate extends City {
  cityId: number;
}

export type CityResolution =
  | { kind: 'found'; cityId: number; city: City }
  | { kind: 'choose'; candidates: CityCandidate[]; total: number }
  | { kind: 'not_found' };

/**
 * Город по словам человека — для часового пояса рождения.
 *
 * Совпадение названия целиком (без регистра, ё/й, латиницей тоже): одно —
 * берём, несколько — варианты для уточнения (или, при явном перевесе
 * населения — DOMINANT_RATIO и больше раз — крупный город берём сразу).
 * Без точного совпадения — города, чьё название или слово в нём начинается с
 * запроса, как подсказки калькулятора, но только вариантами, даже если он
 * один: от города зависит пояс, угадывать нельзя. «Кировск, Мурманская» —
 * до трёх частей после запятой сужают по региону и стране; у городов вроде
 * Москвы или Санкт-Петербурга регион в базе — null (совпадает с названием
 * города), так что подсказка, совпадающая с названием региона, отфильтровала
 * бы их совсем — в этом случае ищем заново без подсказки, но результат всё
 * равно отдаём вариантом, никогда напрямую found: раз человек что-то уточнял,
 * пусть подтвердит явно. cityId — номер записи из прошлого ответа: берётся
 * напрямую. База отсортирована по населению — крупные идут первыми.
 */
export function resolveCity(
  index: CityIndex,
  query: string,
  cityId?: number,
  populations?: number[],
): CityResolution {
  if (cityId !== undefined && cityId !== null) {
    const entry = Number.isInteger(cityId) ? index[cityId] : undefined;
    return entry ? { kind: 'found', cityId, city: entry.city } : { kind: 'not_found' };
  }
  const [namePart, ...rest] = String(query ?? '').split(',');
  const q = normalize(namePart);
  if (q.length < 2) return { kind: 'not_found' };
  const hints = rest.slice(0, MAX_HINTS).map(normalize).filter(Boolean);

  const search = (hintList: string[]) => {
    const fits = (c: City) => hintList.every((h) => normalize(`${c.region ?? ''} ${c.country}`).includes(h));
    const exact: CityCandidate[] = [];
    const partial: CityCandidate[] = [];
    index.forEach(({ city, keys }, id) => {
      if (!fits(city)) return;
      if (keys.includes(q)) exact.push({ ...city, cityId: id });
      else if (partial.length < MAX_CANDIDATES && keys.some((k) => k.startsWith(q) || k.includes(` ${q}`))) {
        partial.push({ ...city, cityId: id });
      }
    });
    return { exact, partial };
  };

  let { exact, partial } = search(hints);
  let dominantAllowed = true;
  if (hints.length > 0 && exact.length === 0 && partial.length === 0) {
    ({ exact, partial } = search([]));
    dominantAllowed = false;
  }

  if (dominantAllowed && exact.length >= 2 && populations) {
    const p0 = populations[exact[0].cityId] ?? 0;
    const p1 = populations[exact[1].cityId] ?? 0;
    if (p1 > 0 && p0 >= DOMINANT_RATIO * p1) {
      const { cityId: id, ...city } = exact[0];
      return { kind: 'found', cityId: id, city };
    }
  }

  if (dominantAllowed && exact.length === 1) {
    const { cityId: id, ...city } = exact[0];
    return { kind: 'found', cityId: id, city };
  }
  if (exact.length > 0) return { kind: 'choose', candidates: exact.slice(0, MAX_CANDIDATES), total: exact.length };
  if (partial.length > 0) return { kind: 'choose', candidates: partial, total: partial.length };
  return { kind: 'not_found' };
}
