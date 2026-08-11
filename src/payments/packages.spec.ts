import { PRIEM_PACKAGES } from './priem.service';
import { PaymentsService } from './payments.service';

/**
 * Прайс живёт на фронте, а число начисляемых токенов — здесь. Репозитории
 * разные, и карта легко отстанет от витрины. Ожидаемая таблица выписана явно:
 * правка карты без правки таблицы роняет сборку.
 */
const EXPECTED_RUB: Array<[string, number]> = [
  ['starter', 50_000],
  ['extended', 200_000],
  ['professional', 1_000_000],
  ['business', 3_000_000],
  ['maximum', 7_000_000],
];

describe('пакеты токенов', () => {
  describe('рублёвая карта', () => {
    // tokensForPackage приватный: он часть контракта оплаты, а не публичный
    // API. Метод не обращается к this, поэтому зовём его через прототип.
    const tokensFor = (id: string, amount = 0): number =>
      (PaymentsService.prototype as any).tokensForPackage.call(null, id, amount);

    for (const [id, tokens] of EXPECTED_RUB) {
      it(`${id} даёт ${tokens} токенов`, () => {
        expect(tokensFor(id)).toBe(tokens);
      });
    }

    it('незнакомый пакет не даёт ноль — откат на формулу от суммы', () => {
      expect(tokensFor('нет-такого', 7)).toBe(7000);
    });
  });

  describe('валютная линейка', () => {
    it('состоит из трёх пакетов', () => {
      expect(PRIEM_PACKAGES.map((p) => p.id)).toEqual(['pro_usd', 'business_usd', 'maximum_usd']);
    });

    // Тот же инвариант, что на фронте: более крупный пакет обязан быть выгоднее.
    it('цена за миллион токенов строго убывает', () => {
      const perMillion = PRIEM_PACKAGES.map((p) => p.usd / (p.tokens / 1_000_000));
      for (let i = 1; i < perMillion.length; i++) {
        expect(perMillion[i]).toBeLessThan(perMillion[i - 1]);
      }
    });

    // Снят с витрины: $19.6 за миллион против $20.7 у business_usd ломало
    // монотонность и делало более крупную покупку невыгодной.
    it('max_usd больше не заказывается', () => {
      expect(PRIEM_PACKAGES.find((p) => p.id === 'max_usd')).toBeUndefined();
    });

    it('все пакеты проходят порог оплаты картой', () => {
      for (const p of PRIEM_PACKAGES) {
        expect(p.usd).toBeGreaterThanOrEqual(10);
      }
    });
  });
});
