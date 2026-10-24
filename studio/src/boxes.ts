import type { ImageBox } from './types';

/** Блок ответа в CSS-пикселях документа (getBoundingClientRect + scrollY). */
export interface CssRect {
  top: number;
  height: number;
  text: string;
}

export const MIN_BLOCK_CSS_PX = 8;

/**
 * Блоки ответа → абзацы на скриншоте (пиксели картинки при deviceScaleFactor = scale).
 * Пустые и крошечные блоки отбрасываются, остальные нумеруются с 1 сверху вниз.
 * Блок, вылезающий за низ картинки, тоже отбрасывается: показать его нечем.
 */
export function toImageBoxes(rects: CssRect[], scale: number, imageHeight = Infinity): ImageBox[] {
  return rects
    .filter((r) => r.height >= MIN_BLOCK_CSS_PX && r.text.trim().length > 0)
    .map((r) => ({
      top: Math.round(r.top * scale),
      height: Math.round(r.height * scale),
      text: r.text.replace(/\s+/g, ' ').trim().slice(0, 120),
    }))
    .filter((b) => b.top + b.height <= imageHeight)
    .sort((a, b) => a.top - b.top)
    .map((b, i) => ({ n: i + 1, ...b }));
}
