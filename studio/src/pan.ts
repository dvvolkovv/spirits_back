/**
 * Сдвиг высокого скриншота по вертикали (пиксели кадра, ≤ 0), при котором
 * середина абзаца встаёт на линию anchorY. Края не показываются: сверху
 * нет пустоты, снизу картинка не кончается раньше кадра.
 */
export function panOffset(o: {
  boxTop: number;
  boxHeight: number;
  imageHeight: number;
  frameHeight: number;
  anchorY: number;
}): number {
  const raw = o.anchorY - (o.boxTop + o.boxHeight / 2);
  const lowest = Math.min(0, o.frameHeight - o.imageHeight);
  return Math.max(lowest, Math.min(0, raw));
}
