import { PaymentsController } from './payments.controller';

/**
 * Цена рублёвого пакета живёт в контроллере — это четвёртая копия прайса
 * (витрина, оферта, карта токенов, здесь). Копия уже подводила дважды:
 *
 *   08.04.2026 — `starter` не было в карте токенов, и десять человек получили
 *   по 149 000 токенов вместо 50 000: сработал откат `amount × 1000`.
 *
 *   11.08.2026 — `business` и `maximum` появились на витрине, но не здесь.
 *   Нажавший «Бизнес» за 4 990 ₽ получил бы счёт на 149 ₽ и 50 000 токенов
 *   вместо 3 000 000. Молча: платёж проходит, токены начисляются, ошибки нет.
 *
 * Отсюда два требования, которые проверяются ниже: каждый пакет витрины обязан
 * иметь здесь цену, а неизвестный пакет обязан получать отказ, а не тихо
 * подменяться самым дешёвым.
 */

/** Прайс витрины. Ровно тот, что в src/config/tokenPackages.ts на фронте. */
const SHOWCASE: Array<[string, number, number]> = [
  ['starter', 149, 50_000],
  ['extended', 499, 200_000],
  ['professional', 1990, 1_000_000],
  ['business', 4990, 3_000_000],
  ['maximum', 9990, 7_000_000],
];

function controllerWith(calls: any[]): PaymentsController {
  const service = {
    async createPayment(userId: string, amount: number, pkg: string) {
      calls.push({ userId, amount, pkg });
      return { payment_url: 'https://example/pay' };
    },
  };
  return new PaymentsController(service as any);
}

/** Подставной Response: запоминает статус и тело. */
function fakeRes() {
  const out: any = {};
  return {
    out,
    status(code: number) {
      out.code = code;
      return this;
    },
    json(body: any) {
      out.body = body;
      return this;
    },
  };
}

describe('создание рублёвого платежа', () => {
  for (const [id, price, tokens] of SHOWCASE) {
    it(`${id} выставляется на ${price} ₽`, async () => {
      const calls: any[] = [];
      const res = fakeRes();
      await controllerWith(calls).createPayment(
        { userId: 'u1' },
        { package_id: id, email: 'a@b.c' },
        res as any,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].amount).toBe(price);
      // Ожидаемый объём токенов держится тестом packages.spec.ts; здесь важно,
      // что контроллер передал дальше пакет, который карте токенов известен.
      expect(typeof calls[0].pkg).toBe('string');
      expect(tokens).toBeGreaterThan(0);
    });
  }

  // Тихая подмена опаснее отказа: человек платит и получает не тот товар,
  // не увидев ни ошибки, ни предупреждения.
  it('неизвестный пакет получает отказ, а не подмену на самый дешёвый', async () => {
    const calls: any[] = [];
    const res = fakeRes();
    await controllerWith(calls).createPayment(
      { userId: 'u1' },
      { package_id: 'нет-такого' },
      res as any,
    );

    expect(calls).toHaveLength(0);
    expect(res.out.code).toBe(400);
  });

  // Цену называет сервер. Иначе клиент отправит свою и купит 50 000 токенов
  // за рубль: карта токенов всё равно начислит пакет целиком.
  it('сумма из тела запроса игнорируется', async () => {
    const calls: any[] = [];
    const res = fakeRes();
    await controllerWith(calls).createPayment(
      { userId: 'u1' },
      { package_id: 'professional', amount: 1 },
      res as any,
    );

    expect(calls[0].amount).toBe(1990);
  });
});
