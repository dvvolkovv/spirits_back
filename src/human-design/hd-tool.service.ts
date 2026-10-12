import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiscService } from '../misc/misc.service';
import { indexCities, type City, type CityDb, type CityIndex } from './cities';
import { resolveCity, type CityCandidate } from './city-resolver';
import { bodygraphPng } from './bodygraph-png';
import { calculateChart, formatOffset, renderBodygraphSvg, type Activation, type HdChart } from './lib';

/** Рядом с собранным файлом: nest-cli.json копирует data/*.json в dist (assets). */
export const CITIES_PATH = join(__dirname, 'data', 'cities.ru.json');

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
      imageUrl: string;
    }
  | { ok: true; kind: 'choose_city'; candidates: CityCandidate[] }
  | { ok: true; kind: 'choose_dst'; transition: 'gap' | 'ambiguous'; before: string; after: string }
  | { ok: false; error: string };

/**
 * Инструмент Райи calculate_human_design: город → пояс → карта модулем
 * калькулятора linkeon.io → бодиграф картинкой. Бесплатный: токены не
 * списываются. Описаний не отдаёт — толкует Райя; коды (manifestor, 5/2)
 * те же, что у калькулятора.
 */
@Injectable()
export class HumanDesignToolService {
  private index: CityIndex | null = null;

  constructor(private readonly misc: MiscService) {}

  /** База городов (1,5 МБ) читается один раз — при первом вызове, не при старте API. */
  private cityIndex(): CityIndex {
    if (!this.index) this.index = indexCities(JSON.parse(readFileSync(CITIES_PATH, 'utf8')) as CityDb);
    return this.index;
  }

  async calculate(input: any): Promise<HdToolResult> {
    const date = String(input?.date ?? '').trim();
    const time = String(input?.time ?? '').trim();
    const city = String(input?.city ?? '').trim();
    const rawId = input?.cityId;
    const cityId = rawId === undefined || rawId === null || rawId === '' ? undefined : Number(rawId);
    const dst = input?.dst === 'before' || input?.dst === 'after' ? input.dst : undefined;
    if (!city && cityId === undefined) return { ok: false, error: 'Нужен город рождения.' };

    const place = resolveCity(this.cityIndex(), city, cityId);
    if (place.kind === 'not_found') {
      return {
        ok: false,
        error: `Город «${city}» не найден в базе. Спросите ближайший крупный город в том же часовом поясе.`,
      };
    }
    if (place.kind === 'choose') return { ok: true, kind: 'choose_city', candidates: place.candidates };

    let result: ReturnType<typeof calculateChart>;
    try {
      result = calculateChart({ date, time, zone: place.city.zone, dst });
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

    const imageUrl = await this.misc.uploadAssetImage(await bodygraphPng(renderBodygraphSvg(chart)), 'png');
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
