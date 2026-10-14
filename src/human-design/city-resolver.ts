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
 * Название и подсказки (регион, страна) разделяет запятая — обычная или
 * китайская «，», а ещё «、» и «；»: так пишут, набирая иероглифами.
 */
export const QUERY_SEPARATORS = /[,，、；]/;

/**
 * Подсказка подходит месту целым словом (whole) или началом слова — но не
 * куском внутри: «us» — не «Massachusetts». Целым словом сверяется сначала:
 * иначе код «CO» совпал бы с началом «Comunidad de Madrid», а «ES» — с
 * «Estados Unidos»; началом слова — если целым не подошёл никто
 * («Chicago, IL» — Illinois, «Кировск, Мурм»).
 */
function placeHas(place: string, hint: string, whole: boolean): boolean {
  if (!whole) return place.startsWith(hint) || place.includes(` ${hint}`);
  return (
    place === hint || place.startsWith(`${hint} `) || place.endsWith(` ${hint}`) || place.includes(` ${hint} `)
  );
}

/** Сведения общего указателя (multilang-index) — без них поиск идёт по русским подписям. */
export interface ResolveExtras {
  /** «Регион страна» на всех языках сайта, код и сокращения страны — нормализованные, по номеру записи. */
  places?: string[];
  /**
   * Сколько первых ключей записи — её собственные названия (русское и
   * латиница GeoNames); остальные — названия на других языках и производные.
   */
  ownKeys?: ArrayLike<number>;
}

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
 * до трёх частей после запятой (QUERY_SEPARATORS) сужают по региону и
 * стране — целым словом, а если так не подходит никто, с начала слова
 * (placeHas): по extras.places — на всех языках сайта, с кодом и
 * сокращением страны («München, Bayern», «慕尼黑，德国», «Chicago, USA»), без
 * них — по русским подписям; у городов вроде
 * Москвы или Санкт-Петербурга регион в базе — null (совпадает с названием
 * города), так что подсказка, совпадающая с названием региона, отфильтровала
 * бы их совсем — в этом случае ищем заново без подсказки, но результат всё
 * равно отдаём вариантом, никогда напрямую found: раз человек что-то уточнял,
 * пусть подтвердит явно. cityId — номер записи из прошлого ответа: берётся
 * напрямую. База отсортирована по населению — крупные идут первыми.
 *
 * Перевес населения не действует, если крупный город совпал только чужим
 * названием (на другом языке или производным), а кто-то из тёзок — своим
 * (extras.ownKeys): «Vienne» — и Вена по-французски, и город Вьенн во
 * Франции, «Sidney» — и Сидней по-испански, и Сидней в Огайо; тут — варианты.
 */
export function resolveCity(
  index: CityIndex,
  query: string,
  cityId?: number,
  populations?: number[],
  extras: ResolveExtras = {},
): CityResolution {
  const { places, ownKeys } = extras;
  if (cityId !== undefined && cityId !== null) {
    const entry = Number.isInteger(cityId) ? index[cityId] : undefined;
    return entry ? { kind: 'found', cityId, city: entry.city } : { kind: 'not_found' };
  }
  const [namePart, ...rest] = String(query ?? '').split(QUERY_SEPARATORS);
  const q = normalize(namePart);
  if (q.length < 2) return { kind: 'not_found' };
  const hints = rest.slice(0, MAX_HINTS).map(normalize).filter(Boolean);

  const search = (hintList: string[], whole = true) => {
    const fits = (c: City, id: number) => {
      if (hintList.length === 0) return true;
      const place = places ? (places[id] ?? '') : normalize(`${c.region ?? ''} ${c.country}`);
      return hintList.every((h) => placeHas(place, h, whole));
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

  /** Запрос совпал с собственным названием записи (без ownKeys — любой ключ считается своим). */
  const byOwnName = (id: number) => {
    const n = ownKeys?.[id];
    return n === undefined || index[id].keys.slice(0, n).includes(q);
  };

  const isDominant = (list: CityCandidate[]) => {
    if (list.length < 2 || !populations) return false;
    const p0 = populations[list[0].cityId] ?? 0;
    const p1 = populations[list[1].cityId] ?? 0;
    if (!(p1 > 0 && p0 >= DOMINANT_RATIO * p1)) return false;
    return byOwnName(list[0].cityId) || !list.slice(1).some((c) => byOwnName(c.cityId));
  };

  let { exact, partial } = search(hints);
  if (hints.length > 0 && exact.length === 0 && partial.length === 0) ({ exact, partial } = search(hints, false));
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
