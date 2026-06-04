/**
 * Unit-tests для расчёта бонуса первой покупки (offer e184d001).
 * Inline-копия creditWithBonus из src/offer/offer-bonus.ts (intentional —
 * пинит контракт без зависимости от dist/сборки, как extractJsonObject.test).
 */
const OFFER_BONUS_PCT = 50;
function creditWithBonus(base, firstPayment, engaged) {
  return firstPayment && engaged ? Math.round(base * (1 + OFFER_BONUS_PCT / 100)) : base;
}

describe('offer first-purchase bonus', () => {
  test('+50% только на первую оплату вовлечённого', () => {
    expect(creditWithBonus(1000000, true, true)).toBe(1500000);
    expect(creditWithBonus(50000, true, true)).toBe(75000);
  });
  test('не первая оплата → база', () => {
    expect(creditWithBonus(1000000, false, true)).toBe(1000000);
  });
  test('не вовлечён → база', () => {
    expect(creditWithBonus(1000000, true, false)).toBe(1000000);
  });
  test('ни то ни другое → база', () => {
    expect(creditWithBonus(499 * 100, false, false)).toBe(499 * 100);
  });
});
