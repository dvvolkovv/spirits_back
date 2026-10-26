/**
 * Тестовый шаблон номеров. Под него уже настроены фильтры аналитики
 * (AttributionService) и белый список debug-ручек бэкенда, поэтому
 * демо-аккаунт не попадает в отчёты, а живой номер студия не возьмёт никогда.
 */
export const DEMO_PHONE_PATTERN = /^790300\d{5}$/;

export function assertDemoPhone(phone: string): string {
  const p = String(phone ?? '').trim();
  if (!DEMO_PHONE_PATTERN.test(p)) {
    throw new Error(`studio: демо-номер обязан подходить под 790300XXXXX, получено «${p}»`);
  }
  return p;
}
