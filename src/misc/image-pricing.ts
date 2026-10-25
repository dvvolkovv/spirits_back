/**
 * Цена картинки в токенах. Одна на генерацию, баннер, правку и объединение;
 * улучшение идёт моделью Pro и всегда стоит как HD. Та же цена — в проверках
 * баланса до работы (misc.controller.ts, chat-tools.ts) и в справке
 * (platform-kb/values.ts), поэтому живёт здесь, а не литералами по месту.
 */
export const IMAGE_TOKENS_STD = 5_000;
export const IMAGE_TOKENS_HD = 10_000;

export function imageTokens(quality?: string): number {
  return quality === 'hd' ? IMAGE_TOKENS_HD : IMAGE_TOKENS_STD;
}
