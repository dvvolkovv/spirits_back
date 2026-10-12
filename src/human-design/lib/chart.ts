import { BODIES, designDate, longitudes, type BodyId } from './ephemeris';
import { gateLine } from './wheel';
import { CENTER_IDS, channelKey, type CenterId } from './bodygraph';
import {
  STRATEGY_OF,
  definedCenters,
  definedChannels,
  hdAuthority,
  hdDefinition,
  hdType,
  type HdAuthority,
  type HdDefinition,
  type HdStrategy,
  type HdType,
} from './rules';
import { localToUtc } from './time';

export interface Activation {
  body: BodyId;
  /** Видимая геоцентрическая долгота, градусы, тропический зодиак. */
  longitude: number;
  gate: number;
  line: number;
}

/** Карта — всё, что считает модуль. Сериализуется в JSON как есть. */
export interface HdChart {
  /** Момент рождения, ISO в UTC. */
  birthUtc: string;
  /** Момент дизайна: Солнце на 88° эклиптической долготы позади Солнца рождения. */
  designUtc: string;
  /** По 13 активаций в порядке BODIES — личность (рождение) и дизайн, всего 26. */
  personality: Activation[];
  design: Activation[];
  /** Все активированные ворота, по возрастанию. */
  gates: number[];
  /** Определённые каналы: «7-31», меньшие ворота первыми. */
  channels: string[];
  definedCenters: CenterId[];
  openCenters: CenterId[];
  type: HdType;
  strategy: HdStrategy;
  authority: HdAuthority;
  /** «5/2»: линия Солнца личности / линия Солнца дизайна. */
  profile: string;
  definition: HdDefinition;
}

function activations(date: Date): Activation[] {
  const lon = longitudes(date);
  return BODIES.map((body) => ({ body, longitude: lon[body], ...gateLine(lon[body]) }));
}

/** Линия Солнца среди активаций. Не позиция 0: явный поиск по body, не по порядку BODIES. */
const sunLine = (xs: Activation[]): number => xs.find((a) => a.body === 'sun')!.line;

/** Карта по моменту рождения в UTC. Место рождения в формулы не входит. */
export function chartFromUtc(birth: Date | string): HdChart {
  const birthDate = new Date(birth);
  if (Number.isNaN(birthDate.getTime())) throw new RangeError(`нет такого момента: ${String(birth)}`);
  const design = designDate(birthDate);
  const personality = activations(birthDate);
  const designActs = activations(design);
  const gates = [...new Set([...personality, ...designActs].map((a) => a.gate))].sort((a, b) => a - b);
  const channels = definedChannels(new Set(gates));
  const defined = definedCenters(channels);
  const type = hdType(channels);
  return {
    birthUtc: birthDate.toISOString(),
    designUtc: design.toISOString(),
    personality,
    design: designActs,
    gates,
    channels: channels.map(channelKey),
    definedCenters: defined,
    openCenters: CENTER_IDS.filter((c) => !defined.includes(c)),
    type,
    strategy: STRATEGY_OF[type],
    authority: hdAuthority(channels),
    profile: `${sunLine(personality)}/${sunLine(designActs)}`,
    definition: hdDefinition(channels),
  };
}

/** Вход публичного интерфейса: местные дата и время рождения и IANA-пояс. */
export interface BirthInput {
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:MM', 24 часа */
  time: string;
  /**
   * IANA: 'Europe/Moscow'. Осторожно с Etc/GMT±N: знак по POSIX обратный,
   * Etc/GMT+3 — это UTC−3.
   */
  zone: string;
  /** Если время попало в час перевода стрелок: по часам до перевода или после. */
  dst?: 'before' | 'after';
}

export type ChartResult =
  | { kind: 'ok'; chart: HdChart; offsetSeconds: number }
  | {
      kind: 'needsDstChoice';
      /** gap — такого времени на часах не было, ambiguous — было дважды. */
      transition: 'gap' | 'ambiguous';
      beforeOffsetSeconds: number;
      afterOffsetSeconds: number;
    };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

/**
 * Карта по местному времени рождения. Время в час перевода стрелок без `dst`
 * не угадывается — возвращается вопрос. Неверный ввод или неизвестный
 * пояс — RangeError.
 */
export function calculateChart(input: BirthInput): ChartResult {
  const d = DATE.exec(input.date);
  const t = TIME.exec(input.time);
  if (!d || !t) throw new RangeError(`дата 'YYYY-MM-DD' и время 'HH:MM', получено ${input.date} ${input.time}`);
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const check = new Date(Date.UTC(y, m - 1, day));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day || Number(t[1]) > 23 || Number(t[2]) > 59) {
    throw new RangeError(`нет такой даты или времени: ${input.date} ${input.time}`);
  }
  const conversion = localToUtc({ date: input.date, time: input.time }, input.zone);
  if (conversion.kind === 'ok') {
    return { kind: 'ok', chart: chartFromUtc(conversion.utc), offsetSeconds: conversion.offsetSeconds };
  }
  if (!input.dst) {
    return {
      kind: 'needsDstChoice',
      transition: conversion.kind,
      beforeOffsetSeconds: conversion.before.offsetSeconds,
      afterOffsetSeconds: conversion.after.offsetSeconds,
    };
  }
  const moment = conversion[input.dst];
  return { kind: 'ok', chart: chartFromUtc(moment.utc), offsetSeconds: moment.offsetSeconds };
}
