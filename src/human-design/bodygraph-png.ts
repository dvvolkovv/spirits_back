// sharp — через require, как в chat-files/thumbnails.ts: esModuleInterop в
// бэкенде нет, default-импорт упал бы в рантайме.
const sharp = require('sharp') as unknown as typeof import('sharp/lib/index');

/** Плотность растеризации: SVG схемы задан в 72 dpi, 144 — вдвое крупнее (720×1096). */
export const BODYGRAPH_PNG_DENSITY = 144;

/**
 * SVG бодиграфа (renderBodygraphSvg модуля — та же схема, что на сайте) →
 * PNG. PNG, а не SVG: картинку показывают все клиенты чата, её можно
 * скачать и переслать. Цифры ворот — текст SVG: sharp рисует их системным
 * sans-serif (Inter на сервере нет). Фон — белый (flatten): SVG схемы
 * прозрачный, а тёмные темы клиентов чата иначе съели бы тонкие линии.
 */
export async function bodygraphPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: BODYGRAPH_PNG_DENSITY })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}
