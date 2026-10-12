const expect = Object.assign((actual: unknown, _message?: string) => globalThis.expect(actual), globalThis.expect) as typeof globalThis.expect;
import { CENTER_GATES, CENTER_IDS, CHANNELS, GATE_CENTER, MOTORS, channelKey, type Channel } from './bodygraph';

describe('устройство бодиграфа', () => {
  it('каждые из 64 ворот — ровно в одном центре', () => {
    const all = CENTER_IDS.flatMap((c) => CENTER_GATES[c]);
    expect(all).toHaveLength(64);
    expect(new Set(all).size).toBe(64);
  });

  it('число ворот по центрам', () => {
    const counts = Object.fromEntries(CENTER_IDS.map((c) => [c, CENTER_GATES[c].length]));
    expect(counts).toEqual({ head: 3, ajna: 6, throat: 11, g: 8, heart: 4, spleen: 7, solarPlexus: 7, sacral: 9, root: 9 });
  });

  it('36 разных каналов, меньшие ворота первыми', () => {
    expect(CHANNELS).toHaveLength(36);
    expect(new Set(CHANNELS.map(channelKey)).size).toBe(36);
    for (const [a, b] of CHANNELS) expect(a).toBeLessThan(b);
  });

  it('канал соединяет два разных центра', () => {
    for (const [a, b] of CHANNELS) {
      expect(GATE_CENTER[a], `${a}`).toBeDefined();
      expect(GATE_CENTER[b], `${b}`).toBeDefined();
      expect(GATE_CENTER[a], channelKey([a, b])).not.toBe(GATE_CENTER[b]);
    }
  });

  // Пары центров — по схеме бодиграфа; ошибка в одном номере ворот перекинула
  // бы канал в чужой центр, и тип посчитался бы неверно.
  it('известные каналы ведут куда надо', () => {
    const between = (a: number, b: number) => [GATE_CENTER[a], GATE_CENTER[b]].sort().join('–');
    expect(between(20, 34)).toBe('sacral–throat');
    expect(between(21, 45)).toBe('heart–throat');
    expect(between(25, 51)).toBe('g–heart');
    expect(between(6, 59)).toBe('sacral–solarPlexus');
    expect(between(10, 57)).toBe('g–spleen');
    expect(between(47, 64)).toBe('ajna–head');
    expect(between(19, 49)).toBe('root–solarPlexus');
  });

  it('моторы — сакрал, солнечное сплетение, сердце, корень', () => {
    expect([...MOTORS].sort()).toEqual(['heart', 'root', 'sacral', 'solarPlexus']);
  });

  it('каждые ворота — хотя бы в одном канале; в трёх — только 10, 20, 34, 57', () => {
    const uses = new Map<number, number>();
    for (const [a, b] of CHANNELS) for (const g of [a, b]) uses.set(g, (uses.get(g) ?? 0) + 1);
    for (let g = 1; g <= 64; g++) expect(uses.get(g), `${g}`).toBe([10, 20, 34, 57].includes(g) ? 3 : 1);
  });

  // Пары центров всех 36 каналов — с карточек «X ↔ Y» на gethumandesign.com/docs/channels,
  // а не из нашей таблицы: иначе тест повторил бы её ошибку.
  it('все 36 каналов ведут куда надо', () => {
    const between = ([a, b]: Channel) => [GATE_CENTER[a], GATE_CENTER[b]].sort().join('–');
    expect(Object.fromEntries(CHANNELS.map((c) => [channelKey(c), between(c)]))).toEqual({
      '1-8': 'g–throat', '2-14': 'g–sacral', '3-60': 'root–sacral', '4-63': 'ajna–head',
      '5-15': 'g–sacral', '6-59': 'sacral–solarPlexus', '7-31': 'g–throat', '9-52': 'root–sacral',
      '10-20': 'g–throat', '10-34': 'g–sacral', '10-57': 'g–spleen', '11-56': 'ajna–throat',
      '12-22': 'solarPlexus–throat', '13-33': 'g–throat', '16-48': 'spleen–throat', '17-62': 'ajna–throat',
      '18-58': 'root–spleen', '19-49': 'root–solarPlexus', '20-34': 'sacral–throat', '20-57': 'spleen–throat',
      '21-45': 'heart–throat', '23-43': 'ajna–throat', '24-61': 'ajna–head', '25-51': 'g–heart',
      '26-44': 'heart–spleen', '27-50': 'sacral–spleen', '28-38': 'root–spleen', '29-46': 'g–sacral',
      '30-41': 'root–solarPlexus', '32-54': 'root–spleen', '34-57': 'sacral–spleen', '35-36': 'solarPlexus–throat',
      '37-40': 'heart–solarPlexus', '39-55': 'root–solarPlexus', '42-53': 'root–sacral', '47-64': 'ajna–head',
    });
  });

  it('центры сверху вниз — в этом порядке их показывает результат', () => {
    expect(CENTER_IDS).toEqual(['head', 'ajna', 'throat', 'g', 'heart', 'spleen', 'solarPlexus', 'sacral', 'root']);
  });
});
