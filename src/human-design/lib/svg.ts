import { CENTER_IDS, CHANNELS, channelKey } from './bodygraph';
import { CENTER_SHAPES, GATE_POINTS, GATE_RADIUS, VIEWBOX, channelHalves } from './layout';
import type { HdChart } from './chart';

/**
 * Бодиграф строкой SVG — без React и DOM: одна и та же функция рисует схему
 * на странице калькулятора и (второй этап) в ответе Райи с бэкенда.
 * Свою графику рисуем сами, графику Jovian Archive не используем.
 *
 * Цвета — атрибутами, а не классами: строка должна выглядеть одинаково и
 * вне лендинга, где его стилей нет.
 */
export interface BodygraphColors {
  /** Ворота и половины каналов личности (момент рождения). */
  personality: string;
  /** Дизайн — около 88 дней до рождения. */
  design: string;
  /** Неактивный канал. */
  channel: string;
  centerDefined: string;
  centerDefinedStroke: string;
  centerOpen: string;
  centerOpenStroke: string;
  gateText: string;
  gateTextActive: string;
}

/** Палитра лендинга: paper-900, rose-700, paper-300, brand-200/800, paper-50/500/600. */
export const DEFAULT_COLORS: BodygraphColors = {
  personality: '#292524',
  design: '#be123c',
  channel: '#ece3d4',
  centerDefined: '#d3f4d3',
  centerDefinedStroke: '#0f766e',
  centerOpen: '#fffdf9',
  centerOpenStroke: '#c9b99a',
  gateText: '#7a6a52',
  gateTextActive: '#ffffff',
};

export interface BodygraphSvgOptions {
  /** Подпись для скринридера и <title>; по умолчанию «Бодиграф». */
  label?: string;
  colors?: Partial<BodygraphColors>;
}

export type GateSource = 'personality' | 'design' | 'both';

/** Чьи активации у ворот: личности, дизайна или обеих карт. */
export function gateSources(chart: HdChart): Map<number, GateSource> {
  const personality = new Set(chart.personality.map((a) => a.gate));
  const design = new Set(chart.design.map((a) => a.gate));
  const sources = new Map<number, GateSource>();
  for (const gate of chart.gates) {
    sources.set(gate, personality.has(gate) && design.has(gate) ? 'both' : personality.has(gate) ? 'personality' : 'design');
  }
  return sources;
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Цвета уходят в атрибуты fill/stroke без экранирования — на втором этапе их
 * может подложить MCP-инструмент, то есть и prompt-injection. Строгий #hex не
 * вырвется за пределы атрибута и не внедрит разметку, когда строку SVG
 * вставят в DOM.
 */
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export function renderBodygraphSvg(chart: HdChart, options: BodygraphSvgOptions = {}): string {
  const c = { ...DEFAULT_COLORS, ...options.colors };
  for (const [key, value] of Object.entries(c)) {
    if (!HEX_COLOR.test(value)) throw new RangeError(`цвет схемы должен быть #hex: ${key}`);
  }
  const label = escape(options.label ?? 'Бодиграф');
  const sources = gateSources(chart);
  const defined = new Set(chart.definedCenters);
  const half = (points: string, source: GateSource | undefined) => {
    if (!source) return '';
    const stroke = source === 'design' ? c.design : c.personality;
    const base = `<polyline points="${points}" stroke="${stroke}"/>`;
    return source === 'both' ? `${base}<polyline points="${points}" stroke="${c.design}" stroke-dasharray="4 4"/>` : base;
  };

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX.width} ${VIEWBOX.height}" width="${VIEWBOX.width}" height="${VIEWBOX.height}" role="img" aria-label="${label}" font-family="Inter, system-ui, sans-serif">`,
    `<title>${label}</title>`,
    '<g fill="none" stroke-width="5" stroke-linecap="round">',
  ];
  for (const channel of CHANNELS) {
    const [first, second] = channelHalves(channel);
    out.push(
      `<g data-channel="${channelKey(channel)}">`,
      `<polyline points="${first} ${second}" stroke="${c.channel}"/>`,
      half(first, sources.get(channel[0])),
      half(second, sources.get(channel[1])),
      '</g>',
    );
  }
  out.push('</g>');
  for (const id of CENTER_IDS) {
    const on = defined.has(id);
    out.push(
      `<polygon points="${CENTER_SHAPES[id].points}" data-center="${id}"${on ? ' data-defined="true"' : ''} fill="${on ? c.centerDefined : c.centerOpen}" stroke="${on ? c.centerDefinedStroke : c.centerOpenStroke}" stroke-width="2" stroke-linejoin="round"/>`,
    );
  }
  for (const [gate, [x, y]] of Object.entries(GATE_POINTS)) {
    const source = sources.get(Number(gate));
    const fill = source === 'design' ? c.design : source ? c.personality : c.centerOpen;
    const stroke = source === 'both' ? c.design : source ? fill : c.centerOpenStroke;
    out.push(
      `<g data-gate="${gate}"${source ? ` data-source="${source}"` : ''}>`,
      `<circle cx="${x}" cy="${y}" r="${GATE_RADIUS}" fill="${fill}" stroke="${stroke}" stroke-width="${source === 'both' ? 2 : 1}"/>`,
      `<text x="${x}" y="${y + 2.6}" text-anchor="middle" font-size="7.5" font-weight="600" fill="${source ? c.gateTextActive : c.gateText}">${gate}</text>`,
      '</g>',
    );
  }
  out.push('</svg>');
  return out.join('');
}
