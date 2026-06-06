/**
 * Unit-тест concat-режима вертикальных Veo-роликов (фидбэк katya: длинное
 * вертикальное видео она собирала из 8с-клипов вручную — автоматизируем).
 * Veo native extend работает ТОЛЬКО в 16:9 ("Aspect ratio of the input video
 * must be 16:9"), поэтому 9:16 длиннее 8с собирается как concat N×8с клипов.
 * Inline-копии логики (intentional, как veoSegments/veoFormat) — пинят контракт:
 *  - детект режима concat (9:16 && >8с);
 *  - quote = N клипов × base (решение владельца 2026-06-06: «по факту N×база»);
 *  - размеры кадра под формат+разрешение.
 */

const VEO_BASE_SEC = 8;
const VEO_PRICING = {
  fast: { base: 90_000, extendUnit: 63_000 },
  standard: { base: 240_000, extendUnit: 170_000 },
};
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
// Детект из createVeoJob.
const isVeoConcat = (aspect, target) => aspect === '9:16' && target > 8;
// veoFrameDims из video.service.
function veoFrameDims(aspect, resolution) {
  if (aspect === '9:16') return resolution === '1080p' ? [1080, 1920] : [720, 1280];
  return resolution === '1080p' ? [1920, 1080] : [1280, 720];
}

describe('Veo concat (vertical >8s)', () => {
  test('режим concat включается только для 9:16 и длины >8с', () => {
    expect(isVeoConcat('9:16', 16)).toBe(true);
    expect(isVeoConcat('9:16', 9)).toBe(true);
    expect(isVeoConcat('9:16', 8)).toBe(false);   // ≤8с — одиночная база
    expect(isVeoConcat('16:9', 24)).toBe(false);  // горизонталь — native extend
    expect(isVeoConcat('16:9', 8)).toBe(false);
  });

  test('число клипов = ceil(target/8)', () => {
    expect(computeVeoConcatQuote('veo-3.1', 9).segments).toBe(2);
    expect(computeVeoConcatQuote('veo-3.1', 16).segments).toBe(2);
    expect(computeVeoConcatQuote('veo-3.1', 17).segments).toBe(3);
    expect(computeVeoConcatQuote('veo-3.1', 24).segments).toBe(3);
    expect(computeVeoConcatQuote('veo-3.1', 60).segments).toBe(8);
  });

  test('цена = N × base (без extend-скидки), Standard и Fast', () => {
    expect(computeVeoConcatQuote('veo-3.1', 16).totalCost).toBe(480_000);    // 2×240k
    expect(computeVeoConcatQuote('veo-3.1', 24).totalCost).toBe(720_000);    // 3×240k
    expect(computeVeoConcatQuote('veo-3.1-fast', 16).totalCost).toBe(180_000); // 2×90k
    expect(computeVeoConcatQuote('veo-3.1-fast', 24).totalCost).toBe(270_000); // 3×90k
  });

  test('сравнение цены concat vs extend зависит от длины (extend переплачивает за 7с-гранулярность)', () => {
    // 24с: extend = база + ceil(16/7)=3 extend'а = 240k + 3×170k = 750k;
    //      concat = 3×8с = 3×240k = 720k → concat даже чуть дешевле.
    expect(computeVeoExtendQuote('veo-3.1', 24).totalCost).toBe(750_000);
    expect(computeVeoConcatQuote('veo-3.1', 24).totalCost).toBe(720_000);
    // 16с: extend = база + ceil(8/7)=2 = 240k + 2×170k = 580k;
    //      concat = 2×240k = 480k → concat дешевле.
    expect(computeVeoExtendQuote('veo-3.1', 16).totalCost).toBe(580_000);
    expect(computeVeoConcatQuote('veo-3.1', 16).totalCost).toBe(480_000);
  });

  test('размеры кадра под формат+разрешение', () => {
    expect(veoFrameDims('9:16', '1080p')).toEqual([1080, 1920]);
    expect(veoFrameDims('9:16', '720p')).toEqual([720, 1280]);
    expect(veoFrameDims('16:9', '1080p')).toEqual([1920, 1080]);
    expect(veoFrameDims('16:9', '720p')).toEqual([1280, 720]);
  });
});
