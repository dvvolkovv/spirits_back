import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiscService } from '../misc/misc.service';
import { normalize, type City, type CityDb, type CityIndex } from './cities';
import { cityNameMatches, resolveCity, type CityCandidate } from './city-resolver';
import { multilingualCities, SITE_LANGUAGES } from './multilang-index';
import { bodygraphPng } from './bodygraph-png';
import { calculateChart, formatOffset, renderBodygraphSvg, type Activation, type HdChart } from './lib';

/**
 * Базы городов cities.<код>.json — рядом с собранным файлом: nest-cli.json
 * копирует data/*.json в dist (assets).
 */
export const CITIES_DIR = join(__dirname, 'data');

/** Город дольше — явно не город, а мусор во входе; не раздувать ошибку. */
const MAX_CITY_LEN = 100;

const CITY_ID_ERROR = 'cityId не из вариантов прошлого ответа — вызовите без cityId.';

type ShortActivation = Pick<Activation, 'body' | 'gate' | 'line'>;

export type HdToolResult =
  | {
      ok: true;
      kind: 'chart';
      city: City;
      offset: string;
      birthUtc: string;
      type: HdChart['type'];
      strategy: HdChart['strategy'];
      authority: HdChart['authority'];
      profile: string;
      definition: HdChart['definition'];
      definedCenters: HdChart['definedCenters'];
      openCenters: HdChart['openCenters'];
      channels: string[];
      personality: ShortActivation[];
      design: ShortActivation[];
      /** null — бодиграф не нарисовался или не загрузился; карта в тексте всё равно верна. */
      imageUrl: string | null;
    }
  | { ok: true; kind: 'choose_city'; candidates: CityCandidate[]; total: number }
  | { ok: true; kind: 'choose_dst'; transition: 'gap' | 'ambiguous'; before: string; after: string }
  | { ok: false; error: string };

/** '1' → 1; дробные, отрицательные, нечисловые строки и всё кроме числа/числовой строки — 'invalid'. */
function parseCityId(raw: unknown): number | undefined | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? raw : 'invalid';
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return 'invalid';
}

/** YYYY-MM-DD, существующий календарный день (отсекает, например, 1990-02-30). */
function isValidCalendarDate(raw: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** H:MM, HH:MM или HH:MM:SS → нормализованное HH:MM; неверный формат или диапазон — null. */
function normalizeTime(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = m[3] !== undefined ? Number(m[3]) : 0;
  if (h > 23 || mi > 59 || s > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/**
 * Инструмент Райи calculate_human_design: город → пояс → карта модулем
 * калькулятора linkeon.io → бодиграф картинкой. Бесплатный: токены не
 * списываются. Описаний не отдаёт — толкует Райя; коды (manifestor, 5/2)
 * те же, что у калькулятора.
 */
@Injectable()
export class HumanDesignToolService {
  private readonly logger = new Logger(HumanDesignToolService.name);
  /** protected, а не private — ради подмены на несуществующий каталог в тесте недоступности базы. */
  protected citiesDir: string = CITIES_DIR;

  private index: CityIndex | null = null;
  private populations: number[] | undefined;
  private places: string[] | undefined;

  constructor(private readonly misc: MiscService) {}

  /**
   * Базы городов на семи языках сайта (по 1,3–1,6 МБ) читаются один раз — при
   * первом вызове, не при старте API — и склеиваются в общий указатель:
   * город ищется по названию на любом языке, подписи русские.
   */
  private cityData(): { index: CityIndex; populations: number[] | undefined; places: string[] | undefined } {
    if (!this.index) {
      const dbs: Record<string, CityDb> = {};
      for (const code of SITE_LANGUAGES) {
        dbs[code] = JSON.parse(readFileSync(join(this.citiesDir, `cities.${code}.json`), 'utf8')) as CityDb;
      }
      const { index, places, populations } = multilingualCities(dbs);
      this.places = places;
      this.populations = populations;
      this.index = index;
    }
    return { index: this.index, populations: this.populations, places: this.places };
  }

  async calculate(input: any): Promise<HdToolResult> {
    const dateRaw = String(input?.date ?? '').trim();
    const timeRaw = String(input?.time ?? '').trim();
    const city = String(input?.city ?? '').trim().slice(0, MAX_CITY_LEN);
    const dst = input?.dst === 'before' || input?.dst === 'after' ? input.dst : undefined;

    const cityId = parseCityId(input?.cityId);
    if (cityId === 'invalid') return { ok: false, error: CITY_ID_ERROR };
    if (!city && cityId === undefined) return { ok: false, error: 'Нужен город рождения.' };

    // Дата и время — раньше города: неверная дата не должна прятаться за
    // уточнением города (если оно, скажем, неоднозначно).
    if (!isValidCalendarDate(dateRaw)) {
      return { ok: false, error: 'Проверьте дату рождения: формат ГГГГ-ММ-ДД, существующий день.' };
    }
    // Запас в сутки: в восточных поясах (Владивосток, UTC+10) местная дата
    // «сегодня» может быть на день больше даты UTC ещё до полуночи по UTC —
    // сравнение строго с датой UTC принимало бы законное «сегодня» за
    // будущее. Точная проверка после расчёта (ниже, по birthUtc) остаётся.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (dateRaw > tomorrow) return { ok: false, error: 'Дата рождения в будущем — проверьте год.' };
    const time = normalizeTime(timeRaw);
    if (time === null) return { ok: false, error: 'Проверьте время рождения: формат ЧЧ:ММ.' };

    let index: CityIndex;
    let populations: number[] | undefined;
    let places: string[] | undefined;
    try {
      ({ index, populations, places } = this.cityData());
    } catch (e: any) {
      this.logger.error(`база городов недоступна: ${e?.message ?? e}`);
      return { ok: false, error: 'Инструмент расчёта временно недоступен — посчитайте прежним способом.' };
    }

    if (cityId !== undefined && city) {
      const entry = index[cityId];
      const q = normalize(city.split(/[,，]/)[0]);
      // Тем же правилом, что строит варианты choose_city (не только точным
      // совпадением): иначе cityId варианта, предложенного по началу слова
      // («Новгород» → Великий Новгород), повторный вызов с тем же city
      // отвергал бы как «чужой».
      if (!entry || !cityNameMatches(entry.keys, q)) return { ok: false, error: CITY_ID_ERROR };
    }

    const place = resolveCity(index, city, cityId, populations, places);
    if (place.kind === 'not_found') {
      return {
        ok: false,
        error:
          `Город «${city}» не найден в базе. Передайте нынешнее официальное название — по-русски или на ` +
          'языке человека (например, Самара, а не Куйбышев) — или ближайший крупный город в том же часовом поясе.',
      };
    }
    if (place.kind === 'choose') {
      return { ok: true, kind: 'choose_city', candidates: place.candidates, total: place.total };
    }

    let result: ReturnType<typeof calculateChart>;
    try {
      result = calculateChart({ date: dateRaw, time, zone: place.city.zone, dst });
    } catch (e: any) {
      return { ok: false, error: `Проверьте дату и время рождения: ${e?.message ?? e}` };
    }
    if (result.kind === 'needsDstChoice') {
      return {
        ok: true,
        kind: 'choose_dst',
        transition: result.transition,
        before: formatOffset(result.beforeOffsetSeconds),
        after: formatOffset(result.afterOffsetSeconds),
      };
    }
    const { chart } = result;
    if (new Date(chart.birthUtc).getTime() > Date.now()) {
      return { ok: false, error: 'Дата рождения в будущем — проверьте год.' };
    }

    let imageUrl: string | null;
    try {
      imageUrl = await this.misc.uploadAssetImage(await bodygraphPng(renderBodygraphSvg(chart)), 'png');
    } catch (e: any) {
      this.logger.warn(`бодиграф не нарисовался или не загрузился: ${e?.message ?? e}`);
      imageUrl = null;
    }

    const short = (a: Activation): ShortActivation => ({ body: a.body, gate: a.gate, line: a.line });
    return {
      ok: true,
      kind: 'chart',
      city: place.city,
      offset: formatOffset(result.offsetSeconds),
      birthUtc: chart.birthUtc,
      type: chart.type,
      strategy: chart.strategy,
      authority: chart.authority,
      profile: chart.profile,
      definition: chart.definition,
      definedCenters: chart.definedCenters,
      openCenters: chart.openCenters,
      channels: chart.channels,
      personality: chart.personality.map(short),
      design: chart.design.map(short),
      imageUrl,
    };
  }
}
