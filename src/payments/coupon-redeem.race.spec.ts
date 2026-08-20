/**
 * Применение промокода не должно начисляться дважды.
 *
 * Инцидент: 05.03.2026 пользователь 79035281880 получил 3 000 000 токенов
 * вместо 1 000 000 — в coupon_redemptions легли три строки с одинаковым
 * coupon_id и совпадающим ДО МИКРОСЕКУНДЫ временем. То есть это не три
 * применения, а один клик, разошедшийся в три параллельных запроса. Всего по
 * базе таких случаев шесть (все ровно ×3, все март–апрель), лишнего роздано
 * 2 300 000 токенов.
 *
 * Причина — «проверить → вставить → начислить» тремя отдельными запросами без
 * транзакции и без блокировки. Параллельные запросы проходят проверку
 * «уже применял?» одновременно, до того как хоть один успел вставить строку.
 * Уникального индекса на (coupon_id, user_id) нет, и БД дубли не отбивает.
 *
 * Лечение — блокировка строки купона (SELECT ... FOR UPDATE) внутри одной
 * транзакции: параллельные применения одного купона выстраиваются в очередь,
 * и второй уже видит строку первого.
 *
 * Ниже подставная БД моделирует ровно эту семантику: FOR UPDATE занимает
 * мьютекс по купону до COMMIT/ROLLBACK. Если из запроса убрать FOR UPDATE —
 * мьютекс не берётся, оба вызова проходят проверку, и тест краснеет. Проверено
 * в обе стороны.
 */
import { PaymentsService } from './payments.service';

/** Подставной пул: таблицы в памяти + честная блокировка строки купона. */
function makeFakePg(coupon: { id: number; code: string; token_amount: number }) {
  const redemptions: Array<{ coupon_id: number; user_id: string }> = [];
  const credits: Array<{ user_id: string; amount: number }> = [];
  const locks = new Map<number, Promise<void>>();
  const log: string[] = [];

  /** Пропускаем тик событийного цикла — без этого параллельности нет. */
  const yieldTick = () => new Promise((r) => setTimeout(r, 0));

  function makeClient() {
    let releaseLock: (() => void) | null = null;

    const unlock = () => {
      if (releaseLock) {
        releaseLock();
        releaseLock = null;
      }
    };

    return {
      released: false,
      async query(sql: string, params?: any[]) {
        log.push(sql.replace(/\s+/g, ' ').trim());
        await yieldTick();

        if (/^\s*BEGIN/i.test(sql)) return { rows: [] };
        if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) {
          unlock();
          return { rows: [] };
        }

        if (/FROM coupons/i.test(sql)) {
          if (!/FOR UPDATE/i.test(sql)) {
            // Без блокировки — параллельные вызовы идут дальше одновременно.
            return { rows: coupon.code === params?.[0] ? [coupon] : [] };
          }
          // Ждём освобождения строки, затем занимаем её до конца транзакции.
          while (locks.has(coupon.id)) await locks.get(coupon.id);
          locks.set(coupon.id, new Promise<void>((resolve) => {
            releaseLock = () => { locks.delete(coupon.id); resolve(); };
          }));
          return { rows: coupon.code === params?.[0] ? [coupon] : [] };
        }

        if (/SELECT .* FROM coupon_redemptions/i.test(sql)) {
          const [couponId, userId] = params as [number, string];
          return { rows: redemptions.filter((r) => r.coupon_id === couponId && r.user_id === userId) };
        }
        if (/INSERT INTO coupon_redemptions/i.test(sql)) {
          const [couponId, userId] = params as [number, string];
          redemptions.push({ coupon_id: couponId, user_id: userId });
          return { rows: [] };
        }
        if (/add_user_tokens/i.test(sql)) {
          const [userId, amount] = params as [string, number];
          credits.push({ user_id: userId, amount });
          return { rows: [{ res: { success: true } }] };
        }
        return { rows: [] };
      },
      release() { unlock(); this.released = true; },
    };
  }

  const clients: any[] = [];
  const pg: any = {
    redemptions, credits, clients, log,
    async getClient() {
      const c = makeClient();
      clients.push(c);
      return c;
    },
    // Часть кода ещё ходит мимо клиента — отдаём тот же обработчик.
    async query(sql: string, params?: any[]) {
      return makeClient().query(sql, params);
    },
  };
  return pg;
}

function makeService(pg: any): PaymentsService {
  return new (PaymentsService as any)(pg);
}

describe('PaymentsService.redeemCoupon — параллельное применение', () => {
  const coupon = { id: 4, code: 'MARKET2026', token_amount: 1_000_000 };

  it('на три одновременных запроса начисляет ровно один раз', async () => {
    const pg = makeFakePg(coupon);
    const svc = makeService(pg);

    const results = await Promise.all([
      svc.redeemCoupon('79035281880', 'MARKET2026'),
      svc.redeemCoupon('79035281880', 'MARKET2026'),
      svc.redeemCoupon('79035281880', 'MARKET2026'),
    ]);

    expect(results.filter((r: any) => r.success)).toHaveLength(1);
    expect(pg.redemptions).toHaveLength(1);
    expect(pg.credits).toEqual([{ user_id: '79035281880', amount: 1_000_000 }]);
  });

  it('строку купона берёт под блокировку внутри транзакции', async () => {
    const pg = makeFakePg(coupon);
    await makeService(pg).redeemCoupon('79035281880', 'MARKET2026');

    expect(pg.log[0]).toMatch(/BEGIN/i);
    expect(pg.log.find((q: string) => /FROM coupons/i.test(q))).toMatch(/FOR UPDATE/i);
    expect(pg.log[pg.log.length - 1]).toMatch(/COMMIT/i);
  });

  it('успешное применение начисляет токены и отпускает соединение', async () => {
    const pg = makeFakePg(coupon);
    const res: any = await makeService(pg).redeemCoupon('79035281880', 'MARKET2026');

    expect(res).toMatchObject({ success: true, tokens_added: 1_000_000 });
    expect(pg.clients.every((c: any) => c.released)).toBe(true);
  });

  it('повторное применение тем же пользователем отбивается и ничего не начисляет', async () => {
    const pg = makeFakePg(coupon);
    const svc = makeService(pg);

    await svc.redeemCoupon('79035281880', 'MARKET2026');
    const second: any = await svc.redeemCoupon('79035281880', 'MARKET2026');

    expect(second.success).toBe(false);
    expect(pg.credits).toHaveLength(1);
    expect(pg.clients.every((c: any) => c.released)).toBe(true);
  });

  it('разным пользователям один купон применяется независимо', async () => {
    const pg = makeFakePg(coupon);
    const svc = makeService(pg);

    const [a, b]: any[] = await Promise.all([
      svc.redeemCoupon('79000000001', 'MARKET2026'),
      svc.redeemCoupon('79000000002', 'MARKET2026'),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(pg.credits).toHaveLength(2);
  });

  it('неизвестный код не начисляет и отпускает соединение', async () => {
    const pg = makeFakePg(coupon);
    const res: any = await makeService(pg).redeemCoupon('79035281880', 'НЕТ-ТАКОГО');

    expect(res.success).toBe(false);
    expect(pg.credits).toHaveLength(0);
    expect(pg.clients.every((c: any) => c.released)).toBe(true);
  });
});
