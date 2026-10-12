/**
 * Модуль расчёта Human Design — публичный интерфейс.
 *
 * Чистый TypeScript без браузерных API и без React: тот же модуль возьмёт
 * второй этап — Райя считает и рисует бодиграф в чате через инструмент MCP
 * на бэкенде (Node). Границу держит boundary.test.ts. Местное время
 * переводится через Intl — он есть и в браузере, и в Node.
 *
 * Контракт:
 *   calculateChart({ date: 'YYYY-MM-DD', time: 'HH:MM', zone: IANA, dst? })
 *     → { kind: 'ok', chart, offsetSeconds }
 *     | { kind: 'needsDstChoice', transition, beforeOffsetSeconds, afterOffsetSeconds }
 *   chartFromUtc(момент в UTC) → HdChart
 *   renderBodygraphSvg(chart, { label?, colors? }) → строка SVG
 * HdChart: birthUtc, designUtc, personality[13] + design[13] (26 активаций),
 * gates, channels, definedCenters, openCenters, type, strategy, authority,
 * profile, definition. Неверный ввод и неизвестный пояс — RangeError.
 */
export { calculateChart, chartFromUtc } from './chart';
export type { Activation, BirthInput, ChartResult, HdChart } from './chart';
export { DEFAULT_COLORS, gateSources, renderBodygraphSvg } from './svg';
export type { BodygraphColors, BodygraphSvgOptions, GateSource } from './svg';
export { formatOffset, localToUtc } from './time';
export type { Conversion, LocalDateTime, Moment } from './time';
export { BODIES } from './ephemeris';
export type { BodyId } from './ephemeris';
export { CENTER_IDS, CHANNELS, channelKey } from './bodygraph';
export type { CenterId, Channel } from './bodygraph';
export { HD_AUTHORITIES, HD_DEFINITIONS, HD_STRATEGIES, HD_TYPES, STRATEGY_OF } from './rules';
export type { HdAuthority, HdDefinition, HdStrategy, HdType } from './rules';
export { gateLine } from './wheel';
