/**
 * Unit-тест concat-режима (фидбэк katya: длинное вертикальное видео она
 * собирала из 8с-клипов вручную — автоматизируем). Veo native extend работал
 * ТОЛЬКО в 16:9 ("Aspect ratio of the input video must be 16:9"), поэтому 9:16
 * длиннее 8с собирается как concat N×8с клипов. С 24.10.2026 движок — Gemini
 * Omni (Veo 3.1 снят): он продлевает максимум до 40с, поэтому горизонталь
 * длиннее 36с тоже идёт склейкой.
 * Inline-копии логики (intentional, как veoSegments/veoFormat) — пинят контракт:
 *  - детект режима concat (needsVeoConcat в video.dto);
 *  - quote = N клипов × base (решение владельца 2026-06-06: «по факту N×база»);
 *  - Standard слит с Fast (решение владельца 2026-10-24);
 *  - размеры кадра под формат+разрешение.
 * Настоящие функции проверяет src/video/video.omni-pipeline.spec.ts.
 */

const VEO_BASE_SEC = 8;
const VEO_PRICE = { base: 90_000, extendUnit: 63_000 };
const VEO_PRICING = { fast: VEO_PRICE, standard: VEO_PRICE };
const veoTier = (model) => (model === 'veo-3.1' ? 'standard' : 'fast');

function computeVeoConcatQuote(model, targetDurationSec) {
  const tier = veoTier(model);
  const p = VEO_PRICING[tier];
  const clips = Math.max(1, Math.ceil(targetDurationSec / VEO_BASE_SEC));
  return { tier, segments: clips, rawDurationSec: clips * VEO_BASE_SEC, totalCost: clips * p.base };
}
function computeVeoExtendQuote(model, targetDurationSec) {
  const tier = veoTier(model);
  const p = VEO_PRICING[tier];
  const extendCount = Math.ceil(Math.max(0, targetDurationSec - VEO_BASE_SEC) / 7);
  return { tier, segments: 1 + extendCount, totalCost: p.base + extendCount * p.extendUnit };
}
// Детект из createVeoJob (needsVeoConcat): цепочка 8с + N×7с не длиннее 40с.
const isVeoConcat = (aspect, target) => aspect === '9:16'
  ? target > 8
  : VEO_BASE_SEC + Math.ceil(Math.max(0, target - VEO_BASE_SEC) / 7) * 7 > 40;
// veoFrameDims из video.service.
function veoFrameDims(aspect, resolution) {
  if (aspect === '9:16') return resolution === '1080p' ? [1080, 1920] : [720, 1280];
  return resolution === '1080p' ? [1920, 1080] : [1280, 720];
}

describe('Veo concat (vertical >8s, horizontal >36s)', () => {
  test('режим concat: 9:16 длиннее 8с и 16:9 длиннее 36с', () => {
    expect(isVeoConcat('9:16', 16)).toBe(true);
    expect(isVeoConcat('9:16', 9)).toBe(true);
    expect(isVeoConcat('9:16', 8)).toBe(false);   // ≤8с — одиночная база
    expect(isVeoConcat('16:9', 24)).toBe(false);  // горизонталь — native extend
    expect(isVeoConcat('16:9', 36)).toBe(false);  // 8 + 4×7 = 36 ≤ 40
    expect(isVeoConcat('16:9', 37)).toBe(true);   // 8 + 5×7 = 43 > 40
    expect(isVeoConcat('16:9', 60)).toBe(true);
    expect(isVeoConcat('16:9', 8)).toBe(false);
  });

  test('число клипов = ceil(target/8)', () => {
    expect(computeVeoConcatQuote('veo-3.1', 9).segments).toBe(2);
    expect(computeVeoConcatQuote('veo-3.1', 16).segments).toBe(2);
    expect(computeVeoConcatQuote('veo-3.1', 17).segments).toBe(3);
    expect(computeVeoConcatQuote('veo-3.1', 24).segments).toBe(3);
    expect(computeVeoConcatQuote('veo-3.1', 60).segments).toBe(8);
  });

  test('цена = N × base (без extend-скидки), Standard стоит как Fast', () => {
    expect(computeVeoConcatQuote('veo-3.1-fast', 16).totalCost).toBe(180_000); // 2×90k
    expect(computeVeoConcatQuote('veo-3.1-fast', 24).totalCost).toBe(270_000); // 3×90k
    expect(computeVeoConcatQuote('veo-3.1', 16).totalCost).toBe(180_000);
    expect(computeVeoConcatQuote('veo-3.1', 24).totalCost).toBe(270_000);
  });

  test('сравнение цены concat vs extend зависит от длины (extend переплачивает за 7с-гранулярность)', () => {
    // 24с: extend = база + ceil(16/7)=3 extend'а = 90k + 3×63k = 279k;
    //      concat = 3×8с = 3×90k = 270k → concat даже чуть дешевле.
    expect(computeVeoExtendQuote('veo-3.1-fast', 24).totalCost).toBe(279_000);
    expect(computeVeoConcatQuote('veo-3.1-fast', 24).totalCost).toBe(270_000);
    // 48с (горизонталь теперь тоже склейкой): extend был бы 90k + 6×63k = 468k,
    //      concat = 6×90k = 540k — решение владельца 2026-10-24.
    expect(computeVeoExtendQuote('veo-3.1-fast', 48).totalCost).toBe(468_000);
    expect(computeVeoConcatQuote('veo-3.1-fast', 48).totalCost).toBe(540_000);
  });

  test('размеры кадра под формат+разрешение', () => {
    expect(veoFrameDims('9:16', '1080p')).toEqual([1080, 1920]);
    expect(veoFrameDims('9:16', '720p')).toEqual([720, 1280]);
    expect(veoFrameDims('16:9', '1080p')).toEqual([1920, 1080]);
    expect(veoFrameDims('16:9', '720p')).toEqual([1280, 720]);
  });
});
