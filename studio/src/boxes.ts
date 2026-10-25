import type { ImageBox, Paragraph } from './types';

/** Блок ответа в CSS-пикселях документа (getBoundingClientRect + scrollY). */
export interface CssRect {
  top: number;
  height: number;
  text: string;
}

export const MIN_BLOCK_CSS_PX = 8;
/** Подсказка в ImageBox.text — начало абзаца. */
export const BOX_HINT_CHARS = 120;
/** Абзац целиком, но не бесконечный: блок кода в ответе не должен раздуть промпт сценариста. */
export const PARAGRAPH_MAX_CHARS = 2000;

export interface AnswerLayout {
  boxes: ImageBox[];
  paragraphs: Paragraph[];
}

/**
 * Блоки ответа → абзацы на скриншоте (пиксели картинки при deviceScaleFactor = scale)
 * и их полный текст. Пустые и крошечные блоки отбрасываются, вылезающие за низ
 * картинки — тоже: показать их нечем. Остальные нумеруются с 1 сверху вниз —
 * одинаково в обоих списках.
 */
export function toAnswerLayout(rects: CssRect[], scale: number, imageHeight = Infinity): AnswerLayout {
  const kept = rects
    .filter((r) => r.height >= MIN_BLOCK_CSS_PX && r.text.trim().length > 0)
    .map((r) => ({
      top: Math.round(r.top * scale),
      height: Math.round(r.height * scale),
      text: r.text.replace(/\s+/g, ' ').trim(),
    }))
    .filter((b) => b.top + b.height <= imageHeight)
    .sort((a, b) => a.top - b.top);
  return {
    boxes: kept.map((b, i) => ({ n: i + 1, top: b.top, height: b.height, text: b.text.slice(0, BOX_HINT_CHARS) })),
    paragraphs: kept.map((b, i) => ({ n: i + 1, text: b.text.slice(0, PARAGRAPH_MAX_CHARS) })),
  };
}

export function toImageBoxes(rects: CssRect[], scale: number, imageHeight = Infinity): ImageBox[] {
  return toAnswerLayout(rects, scale, imageHeight).boxes;
}
