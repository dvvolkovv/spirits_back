/**
 * Рекламные плашки кабинета, которых не должно быть в кадре. Демо-аккаунт —
 * вовлечённый неплатящий, и кабинет показывает ему баннер «Понравилось
 * общение? Откройте полный доступ…» (OfferBanner, spirits_front). Браузер
 * съёмки каждый раз свежий, так что баннер есть в каждой съёмке: он съедает
 * полэкрана над полем ввода, и пузырь вопроса уезжает под шапку
 * (question_hidden, сквозной прогон 26.10.2026). Скрываем стилем, а не
 * кнопкой «закрыть»: закрытие пишется в аккаунт, а стиль ничего не меняет.
 */
export const PROMO_OVERLAYS: readonly string[] = ['[data-testid="offer-banner"]'];

export function hidePromoCss(selectors: readonly string[] = PROMO_OVERLAYS): string {
  return selectors.map((s) => `${s}{display:none!important}`).join('\n');
}
