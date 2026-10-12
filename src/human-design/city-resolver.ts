import { normalize, type City, type CityIndex } from './cities';

export const MAX_CANDIDATES = 5;

/** Вариант для уточнения: cityId — номер записи в базе, им Райя отвечает при повторном вызове. */
export interface CityCandidate extends City {
  cityId: number;
}

export type CityResolution =
  | { kind: 'found'; cityId: number; city: City }
  | { kind: 'choose'; candidates: CityCandidate[] }
  | { kind: 'not_found' };

/**
 * Город по словам человека — для часового пояса рождения.
 *
 * Совпадение названия целиком (без регистра, ё/й, латиницей тоже): одно —
 * берём, несколько — варианты для уточнения. Без точного совпадения — города,
 * чьё название или слово в нём начинается с запроса, как подсказки
 * калькулятора, но только вариантами, даже если он один: от города зависит
 * пояс, угадывать нельзя. «Кировск, Мурманская» — части после запятой сужают
 * по региону и стране. cityId — номер записи из прошлого ответа: берётся
 * напрямую. База отсортирована по населению — крупные идут первыми.
 */
export function resolveCity(index: CityIndex, query: string, cityId?: number): CityResolution {
  if (cityId !== undefined && cityId !== null) {
    const entry = Number.isInteger(cityId) ? index[cityId] : undefined;
    return entry ? { kind: 'found', cityId, city: entry.city } : { kind: 'not_found' };
  }
  const [namePart, ...rest] = String(query ?? '').split(',');
  const q = normalize(namePart);
  if (q.length < 2) return { kind: 'not_found' };
  const hints = rest.map(normalize).filter(Boolean);
  const fits = (c: City) => hints.every((h) => normalize(`${c.region ?? ''} ${c.country}`).includes(h));

  const exact: CityCandidate[] = [];
  const partial: CityCandidate[] = [];
  index.forEach(({ city, keys }, id) => {
    if (!fits(city)) return;
    if (keys.includes(q)) exact.push({ ...city, cityId: id });
    else if (partial.length < MAX_CANDIDATES && keys.some((k) => k.startsWith(q) || k.includes(` ${q}`))) {
      partial.push({ ...city, cityId: id });
    }
  });

  if (exact.length === 1) {
    const { cityId: id, ...city } = exact[0];
    return { kind: 'found', cityId: id, city };
  }
  if (exact.length > 1) return { kind: 'choose', candidates: exact.slice(0, MAX_CANDIDATES) };
  if (partial.length > 0) return { kind: 'choose', candidates: partial };
  return { kind: 'not_found' };
}
