const jestExpect = (globalThis as unknown as { expect: jest.Expect }).expect;
const expect = Object.assign(<T>(actual: T, _message?: string) => jestExpect(actual), jestExpect);
// @vitest-environment node
import { DEFAULT_COLORS, gateSources, renderBodygraphSvg } from './svg';
import { chartFromUtc } from './chart';
import { CHANNELS, channelKey } from './bodygraph';

/**
 * Схема рисуется строкой без DOM — второй этап вызовет ту же функцию в Node
 * на бэкенде. Окружение здесь — node: ни window, ни document.
 */
const chart = chartFromUtc('1990-03-12T11:25:00Z');
const svg = renderBodygraphSvg(chart, { label: 'Бодиграф: Манифестор' });
const count = (re: RegExp) => (svg.match(re) ?? []).length;

/** Самозакрытые и парные теги сходятся — строка разбирается как XML. */
function unbalanced(xml: string): string[] {
  const stack: string[] = [];
  const problems: string[] = [];
  for (const [, closing, name, , selfClosing] of xml.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g)) {
    if (selfClosing) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) problems.push(`</${name}>`);
  }
  return [...problems, ...stack.map((n) => `<${n}> не закрыт`)];
}

describe('бодиграф строкой SVG', () => {
  it('работает без браузера', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('самостоятельный SVG: пространство имён, размеры, подпись', () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 548"')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('<title>Бодиграф: Манифестор</title>');
    expect(svg).toContain('role="img"');
  });

  it('теги сходятся, лишнего в строке нет', () => {
    expect(unbalanced(svg)).toEqual([]);
    // Всё, что не тег, — текст между тегами: номера ворот и подпись.
    expect(svg.replace(/<[^>]+>/g, '').replace(/\d+/g, '').replace('Бодиграф: Манифестор', '')).toBe('');
    expect(svg).not.toMatch(/undefined|NaN|null/);
  });

  it('девять центров, 36 каналов, 64 ворот; закрашены определённые', () => {
    expect(count(/<polygon /g)).toBe(9);
    expect(count(/data-channel="/g)).toBe(36);
    expect(count(/<circle /g)).toBe(64);
    const defined = [...svg.matchAll(/data-center="(\w+)" data-defined="true"/g)].map((m) => m[1]);
    expect(defined).toEqual(chart.definedCenters);
  });

  it('подпись экранируется', () => {
    const evil = renderBodygraphSvg(chart, { label: '<script>"&' });
    expect(evil).toContain('<title>&lt;script&gt;&quot;&amp;</title>');
    expect(evil).not.toContain('<script>');
  });

  it('цвета можно заменить', () => {
    expect(renderBodygraphSvg(chart, { colors: { design: '#ff0000' } })).toContain('#ff0000');
  });

  it('цвет не #hex — RangeError: строку вставляют в DOM, атрибут не должен ломаться', () => {
    expect(() => renderBodygraphSvg(chart, { colors: { design: '" onmouseover="x' } })).toThrow(RangeError);
    expect(() => renderBodygraphSvg(chart, { colors: { design: 'red' } })).toThrow(RangeError);
    expect(() => renderBodygraphSvg(chart, { colors: { design: '#c0392b' } })).not.toThrow();
  });

  it('DEFAULT_COLORS сами проходят проверку', () => {
    expect(() => renderBodygraphSvg(chart)).not.toThrow();
  });
});

describe('раскраска схемы', () => {
  // Пример из шага 8: на этой карте каналы 11-56, 20-34 и 39-55 определены
  // целиком, а личность и дизайн не совпадают — удобный фиксатор для мутаций.
  const fixedChart = chartFromUtc('2001-11-23T22:50:00Z');
  const fixedSvg = renderBodygraphSvg(fixedChart);
  const fixedSources = gateSources(fixedChart);

  /** Содержимое <g data-gate="N">…</g> или <g data-channel="K">…</g>. */
  const groupBody = (svg: string, attr: string, value: string) =>
    svg.match(new RegExp(`<g data-${attr}="${value}"[^>]*>([^]*?)</g>`))?.[1] ?? '';

  it('кружок ворот окрашен по источнику активации: личность или дизайн', () => {
    const personalityGate = [...fixedSources.entries()].find(([, s]) => s === 'personality')?.[0];
    const designGate = [...fixedSources.entries()].find(([, s]) => s === 'design')?.[0];
    expect(personalityGate, 'в примере нет ворот только личности').toBeDefined();
    expect(designGate, 'в примере нет ворот только дизайна').toBeDefined();

    const circleFill = (gate: number) =>
      groupBody(fixedSvg, 'gate', String(gate)).match(/<circle[^>]*fill="(#[0-9a-fA-F]+)"/)?.[1];
    expect(circleFill(personalityGate!)).toBe(DEFAULT_COLORS.personality);
    expect(circleFill(designGate!)).toBe(DEFAULT_COLORS.design);
  });

  it('висячий канал — закрашена ровно одна половина, у активного конца', () => {
    const hanging = CHANNELS.find(([a, b]) => {
      const sa = fixedSources.get(a);
      const sb = fixedSources.get(b);
      return (sa !== undefined) !== (sb !== undefined) && (sa ?? sb) !== 'both';
    });
    expect(hanging, 'в примере нет подходящего висячего канала').toBeDefined();
    const [a, b] = hanging!;
    const activeColor = (fixedSources.get(a) ?? fixedSources.get(b)) === 'design' ? DEFAULT_COLORS.design : DEFAULT_COLORS.personality;
    const body = groupBody(fixedSvg, 'channel', channelKey(hanging!));
    const polylines = body.match(/<polyline /g) ?? [];
    const colored = body.match(new RegExp(`stroke="${activeColor}"`, 'g')) ?? [];
    // Фон (c.channel) плюс ровно одна цветная половина — вторая половина без polyline.
    expect(polylines.length, channelKey(hanging!)).toBe(2);
    expect(colored.length, channelKey(hanging!)).toBe(1);
  });

  it('канал 39-55: оба конца активны — закрашены обе половины', () => {
    expect(fixedSources.get(39), 'пример завязан на конкретную карту: 39 должны быть активны').toBeDefined();
    expect(fixedSources.get(55), 'пример завязан на конкретную карту: 55 должны быть активны').toBeDefined();
    const body = groupBody(fixedSvg, 'channel', '39-55');
    const polylines = body.match(/<polyline /g) ?? [];
    const colored = body.match(new RegExp(`stroke="(?:${DEFAULT_COLORS.personality}|${DEFAULT_COLORS.design})"`, 'g')) ?? [];
    // Фон (c.channel) плюс как минимум по одной цветной половине на каждый конец.
    expect(polylines.length).toBeGreaterThanOrEqual(3);
    expect(colored.length).toBeGreaterThanOrEqual(2);
  });
});
