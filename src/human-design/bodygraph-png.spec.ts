import { chartFromUtc, renderBodygraphSvg } from './lib';
import { BODYGRAPH_PNG_DENSITY, bodygraphPng } from './bodygraph-png';

const sharp = require('sharp') as unknown as typeof import('sharp/lib/index');

describe('бодиграф картинкой', () => {
  it('PNG вдвое крупнее схемы 360×548, белый фон без прозрачности', async () => {
    const png = await bodygraphPng(renderBodygraphSvg(chartFromUtc('1990-03-12T11:25:00Z')));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const meta = await sharp(png).metadata();
    expect(BODYGRAPH_PNG_DENSITY).toBe(144);
    expect([meta.width, meta.height]).toEqual([720, 1096]);
    expect(meta.hasAlpha).toBe(false);
  });
});
