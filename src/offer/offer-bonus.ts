// Оффер вовлечённому неплатящему: +50% токенов к ПЕРВОЙ оплате (e184d001).
// Чистая функция — пинится unit-тестом (tests/unit/offerBonus.test.js).
export const OFFER_MSG_THRESHOLD = 15;
export const OFFER_BONUS_PCT = 50;

/**
 * Сколько токенов начислить с учётом бонуса первой покупки.
 * Бонус (+50%) — только если это первая успешная оплата И пользователь
 * вовлечён (>= порога сообщений). Иначе — база.
 */
export function creditWithBonus(base: number, firstPayment: boolean, engaged: boolean): number {
  return firstPayment && engaged ? Math.round(base * (1 + OFFER_BONUS_PCT / 100)) : base;
}
