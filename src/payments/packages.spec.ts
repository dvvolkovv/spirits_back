import { PACKAGES, ALIASES, resolvePackage } from './packages';
import { PRIEM_PACKAGES } from './priem.service';

/**
 * Прайс — не тот код, где незамеченная правка допустима. Ожидаемая таблица
 * выписана отдельно от реализации: правка цены «мимоходом» роняет тест, и
 * менять прайс приходится осознанно, в двух местах.
 */
const EXPECTED: Array<[string, number, number]> = [
  ['starter', 149, 50_000],
  ['extended', 499, 200_000],
  ['professional', 1990, 1_000_000],
  ['business', 4990, 3_000_000],
  ['maximum', 9990, 7_000_000],
];

const per1000 = (p: { priceRub: number; tokens: number }) => p.priceRub / (p.tokens / 1000);
const BASE_PER_1000 = 149 / 50;

describe('прайс токенов', () => {
  it('совпадает с согласованным списком', () => {
    expect(PACKAGES.map((p) => [p.id, p.priceRub, p.tokens])).toEqual(EXPECTED);
  });

  // Немонотонная лестница делает более крупную покупку невыгодной.
  it('цена за 1000 токенов строго убывает', () => {
    const prices = PACKAGES.map(per1000);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeLessThan(prices[i - 1]);
    }
  });

  it('ярлык скидки не превышает фактическую выгоду', () => {
    for (const p of PACKAGES) {
      if (p.savingsPct === undefined) continue;
      expect(p.savingsPct).toBeLessThanOrEqual((1 - per1000(p) / BASE_PER_1000) * 100);
    }
  });

  it('ярлык скидки кратен пяти', () => {
    for (const p of PACKAGES) {
      if (p.savingsPct === undefined) continue;
      expect(p.savingsPct % 5).toBe(0);
    }
  });

  it('у базового пакета ярлыка нет', () => {
    expect(PACKAGES[0].savingsPct).toBeUndefined();
  });
});

describe('псевдонимы', () => {
  it('исторические имена ведут на живые пакеты', () => {
    for (const [alias, target] of Object.entries(ALIASES)) {
      expect(PACKAGES.some((p) => p.id === target)).toBe(true);
      expect(PACKAGES.some((p) => p.id === alias)).toBe(false);
    }
  });

  it('resolvePackage находит пакет и по своему имени, и по псевдониму', () => {
    expect(resolvePackage('professional')?.priceRub).toBe(1990);
    expect(resolvePackage('premium')?.priceRub).toBe(1990);
    expect(resolvePackage('basic')?.tokens).toBe(50_000);
  });

  it('resolvePackage не выдумывает пакет для незнакомого имени', () => {
    expect(resolvePackage('нет-такого')).toBeUndefined();
  });
});

describe('валютная линейка', () => {
  it('состоит из трёх пакетов', () => {
    expect(PRIEM_PACKAGES.map((p) => p.id)).toEqual(['pro_usd', 'business_usd', 'maximum_usd']);
  });

  it('цена за миллион токенов строго убывает', () => {
    const perMillion = PRIEM_PACKAGES.map((p) => p.usd / (p.tokens / 1_000_000));
    for (let i = 1; i < perMillion.length; i++) {
      expect(perMillion[i]).toBeLessThan(perMillion[i - 1]);
    }
  });

  it('max_usd больше не заказывается', () => {
    expect(PRIEM_PACKAGES.find((p) => p.id === 'max_usd')).toBeUndefined();
  });
});
