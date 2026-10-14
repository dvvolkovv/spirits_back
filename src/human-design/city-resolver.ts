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

/**
 * То же правило, что строит exact/partial в resolveCity: название целиком
 * или начало слова в нём совпадает с q (уже нормализованным запросом).
 * Экспортирован, чтобы сервис инструмента сверял cityId из прошлого ответа
 * choose_city с тем же критерием — иначе cityId варианта, найденного по
 * началу слова («Новгород» → Великий Новгород), сервис отвергал бы как
 * «чужой», хотя он ровно из только что предложенных вариантов.
 */
export function cityNameMatches(keys: string[], q: string): boolean {
  return keys.includes(q) || keys.some((k) => k.startsWith(q) || k.includes(` ${q}`));
}

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
 * Совпадение названия целиком (без регистра, ё/й, латиницей тоже; с общим
 * указателем multilang-index — и на любом языке сайта): одно —
 * берём, несколько — варианты для уточнения (или, при явном перевесе
 * населения — DOMINANT_RATIO и больше раз — крупный город берём сразу).
 * Без точного совпадения — города, чьё название или слово в нём начинается с
 * запроса, как подсказки калькулятора, но только вариантами, даже если он
 * один: от города зависит пояс, угадывать нельзя. «Кировск, Мурманская» —
 * до трёх частей после запятой (и китайской «，») сужают по региону и
 * стране: по places — «регион страна» на всех языках сайта («München,
 * Bayern», «慕尼黑，德国»), без places — по русским подписям; у городов вроде
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
  places?: string[],
): CityResolution {
  if (cityId !== undefined && cityId !== null) {
    const entry = Number.isInteger(cityId) ? index[cityId] : undefined;
    return entry ? { kind: 'found', cityId, city: entry.city } : { kind: 'not_found' };
  }
  const [namePart, ...rest] = String(query ?? '').split(/[,，]/);
  const q = normalize(namePart);
  if (q.length < 2) return { kind: 'not_found' };
  const hints = rest.slice(0, MAX_HINTS).map(normalize).filter(Boolean);

  const search = (hintList: string[]) => {
    const fits = (c: City, id: number) => {
      if (hintList.length === 0) return true;
      const place = places ? (places[id] ?? '') : normalize(`${c.region ?? ''} ${c.country}`);
      return hintList.every((h) => place.includes(h));
    };
    const exact: CityCandidate[] = [];
    const partial: CityCandidate[] = [];
    index.forEach(({ city, keys }, id) => {
      if (!fits(city, id)) return;
      if (keys.includes(q)) exact.push({ ...city, cityId: id });
      else if (partial.length < MAX_CANDIDATES && cityNameMatches(keys, q)) {
        partial.push({ ...city, cityId: id });
      }
    });
    return { exact, partial };
  };

  const isDominant = (list: CityCandidate[]) => {
    if (list.length < 2 || !populations) return false;
    const p0 = populations[list[0].cityId] ?? 0;
    const p1 = populations[list[1].cityId] ?? 0;
    return p1 > 0 && p0 >= DOMINANT_RATIO * p1;
  };

  let { exact, partial } = search(hints);
  let dominantAllowed = true;
  if (hints.length > 0 && exact.length === 0 && partial.length === 0) {
    ({ exact, partial } = search([]));
    dominantAllowed = false;
    // Подсказка была нужна человеку — доминирующего тёзку всё равно не
    // отдаём напрямую found, но и не заставляем выбирать среди явно
    // нерелевантных: сокращаем список до одного (самого крупного).
    if (isDominant(exact)) exact = [exact[0]];
  }

  if (dominantAllowed && isDominant(exact)) {
    const { cityId: id, ...city } = exact[0];
    return { kind: 'found', cityId: id, city };
  }

  if (dominantAllowed && exact.length === 1) {
    const { cityId: id, ...city } = exact[0];
    return { kind: 'found', cityId: id, city };
  }
  if (exact.length > 0) return { kind: 'choose', candidates: exact.slice(0, MAX_CANDIDATES), total: exact.length };
  if (partial.length > 0) return { kind: 'choose', candidates: partial, total: partial.length };
  return { kind: 'not_found' };
}
