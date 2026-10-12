/**
 * Устройство бодиграфа: девять центров, их ворота и 36 каналов.
 * Списки сверены 08.10.2026 с карточками 36 каналов на gethumandesign.com/docs/channels
 * и с github.com/schokee/Astrolo (Metadata/Gates.csv) — расхождений нет.
 */
export type CenterId =
  | 'head' | 'ajna' | 'throat' | 'g' | 'heart' | 'spleen' | 'solarPlexus' | 'sacral' | 'root';

/** Порядок — сверху вниз по схеме: так центры и перечисляются в результате. */
export const CENTER_IDS: readonly CenterId[] = [
  'head', 'ajna', 'throat', 'g', 'heart', 'spleen', 'solarPlexus', 'sacral', 'root',
];

/** Моторы: их связь с горлом делает тип «манифестирующим». */
export const MOTORS: readonly CenterId[] = ['sacral', 'solarPlexus', 'heart', 'root'];

export const CENTER_GATES: Readonly<Record<CenterId, readonly number[]>> = {
  head: [64, 61, 63],
  ajna: [47, 24, 4, 17, 43, 11],
  throat: [62, 23, 56, 35, 12, 45, 33, 8, 31, 20, 16],
  g: [7, 1, 13, 10, 25, 15, 46, 2],
  heart: [21, 40, 26, 51],
  spleen: [48, 57, 44, 50, 32, 28, 18],
  solarPlexus: [6, 37, 22, 36, 30, 55, 49],
  sacral: [5, 14, 29, 59, 9, 3, 42, 27, 34],
  root: [53, 60, 52, 19, 39, 41, 58, 38, 54],
};

export type Channel = readonly [number, number];

/** Меньшие ворота — первыми; так же канал и называется: «20-34». */
export const CHANNELS: readonly Channel[] = [
  [1, 8], [2, 14], [3, 60], [4, 63], [5, 15], [6, 59], [7, 31], [9, 52], [10, 20],
  [10, 34], [10, 57], [11, 56], [12, 22], [13, 33], [16, 48], [17, 62], [18, 58], [19, 49],
  [20, 34], [20, 57], [21, 45], [23, 43], [24, 61], [25, 51], [26, 44], [27, 50], [28, 38],
  [29, 46], [30, 41], [32, 54], [34, 57], [35, 36], [37, 40], [39, 55], [42, 53], [47, 64],
];

/** Центр ворот. Только для ворот 1–64; для других номеров — undefined. */
export const GATE_CENTER: Readonly<Record<number, CenterId>> = Object.fromEntries(
  CENTER_IDS.flatMap((center) => CENTER_GATES[center].map((gate) => [gate, center])),
);

/** Имя канала «20-34». Пару не упорядочивает — только для элементов CHANNELS, где меньшие ворота первыми. */
export const channelKey = ([a, b]: Channel): string => `${a}-${b}`;
