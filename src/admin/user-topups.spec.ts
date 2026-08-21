/**
 * В карточке пользователя админка должна показывать пополнения отдельно.
 *
 * Раньше там был общий список последних 20 транзакций. У активного человека
 * это 20 списаний за ответы ассистента подряд, и пополнения в него просто не
 * попадают: у 79035281880 их 13 против 912 списаний. Вопрос «когда и на что
 * пополнялся» из админки не решался вообще — я отвечал на него запросами в
 * psql.
 *
 * Отдельные требования, которые тут закреплены:
 *  - купон показывается кодом, а не идентификатором (коды после раздачи
 *    удаляют — тогда честно отдаём null, а не выдумываем);
 *  - у покупки видна рублёвая сумма;
 *  - остаток после операции у восстановленных задним числом строк — null,
 *    потому что в базе там ноль-заглушка (миграция 002_backfill).
 */
import { AdminService } from './admin.service';

/** Фейковый pg: отвечает по форме запроса, остальное — пустые строки. */
function makePg(topupRows: any[], totalsRows: any[]) {
  const seen: string[] = [];
  return {
    seen,
    async query(sql: string, params?: any[]) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      seen.push(flat);

      if (/FROM ai_profiles_consolidated a/i.test(flat)) {
        return { rows: [{ phone: '79035281880', balance: 865046, registered_at: new Date(), profile_data: {} }] };
      }
      if (/FROM token_transactions t/i.test(flat) && /LIMIT 100/.test(flat)) {
        return { rows: topupRows };
      }
      if (/GROUP BY t.transaction_type|GROUP BY 1/i.test(flat) && /transaction_type/i.test(flat)) {
        return { rows: totalsRows };
      }
      return { rows: [] };
    },
  } as any;
}

const service = (pg: any) => new (AdminService as any)(pg);

describe('AdminService.getUserActivity — блок пополнений', () => {
  const rows = [
    {
      created_at: '2026-07-30T08:32:43Z', type: 'purchase', amount: '1000000',
      balance_after: '0', description: 'Пополнение: premium',
      metadata: { reconstructed: true, payment_id: 'pay-1' }, coupon_code: null,
      rub: '1990.00', provider: 'yookassa', package_id: 'premium',
    },
    {
      created_at: '2026-08-18T20:38:26Z', type: 'coupon', amount: '1000000',
      balance_after: '1074323', description: 'Промокод',
      metadata: { coupon_id: 40 }, coupon_code: 'MARKETAUGUST26',
      rub: null, provider: null, package_id: null,
    },
    {
      created_at: '2026-03-05T08:00:09Z', type: 'coupon', amount: '1000000',
      balance_after: '0', description: 'Промокод',
      metadata: { coupon_id: 4, reconstructed: true }, coupon_code: null,
      rub: null, provider: null, package_id: null,
    },
  ];
  const totals = [
    { type: 'purchase', tokens: '1000000', count: 1 },
    { type: 'coupon', tokens: '12000000', count: 12 },
  ];

  it('отдаёт пополнения отдельным списком, без списаний', async () => {
    const pg = makePg(rows, totals);
    const data: any = await service(pg).getUserActivity('79035281880', {});

    expect(data.topups).toHaveLength(3);
    const creditsQuery = pg.seen.find((s: string) => /FROM token_transactions t/i.test(s) && /LIMIT 100/.test(s));
    expect(creditsQuery).toMatch(/transaction_type <> 'consumed'/);
  });

  it('купон показывает кодом, а удалённый — честно без кода', async () => {
    const data: any = await service(makePg(rows, totals)).getUserActivity('79035281880', {});

    expect(data.topups[1]).toMatchObject({ type: 'coupon', couponCode: 'MARKETAUGUST26' });
    expect(data.topups[2]).toMatchObject({ type: 'coupon', couponCode: null, couponId: 4 });
  });

  it('у покупки видна рублёвая сумма и провайдер', async () => {
    const data: any = await service(makePg(rows, totals)).getUserActivity('79035281880', {});

    expect(data.topups[0]).toMatchObject({ type: 'purchase', rub: 1990, provider: 'yookassa', packageId: 'premium' });
  });

  it('остаток у восстановленных строк — null, а не ноль из базы', async () => {
    const data: any = await service(makePg(rows, totals)).getUserActivity('79035281880', {});

    expect(data.topups[0].balanceAfter).toBeNull();
    expect(data.topups[2].balanceAfter).toBeNull();
    expect(data.topups[1].balanceAfter).toBe(1074323);
  });

  it('считает итоги по видам пополнений', async () => {
    const data: any = await service(makePg(rows, totals)).getUserActivity('79035281880', {});

    expect(data.topupTotals).toEqual(
      expect.arrayContaining([
        { type: 'purchase', tokens: 1000000, count: 1 },
        { type: 'coupon', tokens: 12000000, count: 12 },
      ]),
    );
  });

  it('пустая история не роняет карточку', async () => {
    const data: any = await service(makePg([], [])).getUserActivity('79035281880', {});

    expect(data.topups).toEqual([]);
    expect(data.topupTotals).toEqual([]);
  });
});
