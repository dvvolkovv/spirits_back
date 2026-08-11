/**
 * Прайс токенов — единственный владелец цифр во всей системе.
 *
 * До этого модуля цена жила в четырёх местах: витрина приложения, таблица цен
 * в контроллере оплаты, карта объёмов в сервисе и прайс лендинга. Копии
 * расходились дважды. 08.04.2026 у `starter` не было объёма, сработал откат
 * `amount × 1000`, и десять человек получили по 149 000 токенов вместо 50 000.
 * 11.08.2026 новые тарифы не доехали до таблицы цен, и «Бизнес» за 4 990 ₽
 * выставил бы счёт на 149 ₽ с начислением 50 000 вместо 3 000 000.
 *
 * Проценты скидок — ЯРЛЫКИ, а не расчёт: округлены вниз до пятёрки, чтобы
 * обещание в интерфейсе оставалось заведомо выполнимым. Тест рядом следит,
 * чтобы ярлык не обогнал фактическую выгоду.
 */

export interface TokenPackage {
  id: string;
  priceRub: number;
  tokens: number;
  /** Ярлык скидки в процентах. У базового пакета отсутствует. */
  savingsPct?: number;
}

export const PACKAGES: TokenPackage[] = [
  { id: 'starter', priceRub: 149, tokens: 50_000 },
  { id: 'extended', priceRub: 499, tokens: 200_000, savingsPct: 15 },
  { id: 'professional', priceRub: 1990, tokens: 1_000_000, savingsPct: 30 },
  { id: 'business', priceRub: 4990, tokens: 3_000_000, savingsPct: 40 },
  { id: 'maximum', priceRub: 9990, tokens: 7_000_000, savingsPct: 50 },
];

/**
 * Исторические имена пакетов. Держатся отдельно от прайса намеренно: они
 * нужны старым клиентам, но тарифами не являются и наружу не отдаются —
 * иначе витрина показала бы восемь позиций вместо пяти.
 */
export const ALIASES: Record<string, string> = {
  basic: 'starter',
  standard: 'extended',
  premium: 'professional',
};

/** Пакет по имени или историческому псевдониму. undefined — имя незнакомое. */
export function resolvePackage(id: string): TokenPackage | undefined {
  const key = ALIASES[id] ?? id;
  return PACKAGES.find((p) => p.id === key);
}
