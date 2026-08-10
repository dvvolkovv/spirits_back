import { AdminService } from './admin.service';

/**
 * Раздел «Платежи» в админке.
 *
 * Здесь два разных провайдера в одной таблице: YooKassa пишет рубли, «Приём»
 * (крипта и иностранные карты) — доллары. До этих правок выдача не отдавала ни
 * provider, ни currency, а статистика складывала `SUM(amount)` по всей таблице,
 * то есть $25 приходили в выручку как 25 ₽. Проверяется ровно это: суммы
 * разложены по валютам и никогда не схлопываются в одно число.
 *
 * Второе — тестовые аккаунты. Они по-прежнему скрыты по умолчанию (выручка
 * должна оставаться выручкой), но админка обязана уметь их показать: пока все
 * платежи «Приёма» — это наши собственные прогоны, и без includeTest раздел
 * выглядит пустым, хотя провайдер работает.
 */

interface Recorded {
  sql: string;
  params: any[];
}

/** Подставной pg: запоминает запросы и отдаёт заготовленные ответы. */
function fakePg(rows: Record<string, any[]> = {}) {
  const calls: Recorded[] = [];
  return {
    calls,
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params });
      for (const [needle, value] of Object.entries(rows)) {
        if (sql.includes(needle)) return { rows: value };
      }
      return { rows: [] };
    },
  };
}

function serviceWith(pg: any): AdminService {
  return new AdminService(pg as any);
}

/** Запрос, который выбирает сам список платежей (а не агрегаты). */
const listSql = (pg: ReturnType<typeof fakePg>) =>
  pg.calls.find(c => c.sql.includes('FROM payments p'))!.sql;

describe('AdminService — платежи', () => {
  describe('listPayments', () => {
    it('отдаёт провайдера и валюту — иначе $25 не отличить от 25 ₽', async () => {
      const pg = fakePg();
      await serviceWith(pg).listPayments();

      expect(listSql(pg)).toContain('p.provider');
      expect(listSql(pg)).toContain('p.currency');
    });

    it('по умолчанию прячет тестовые аккаунты', async () => {
      const pg = fakePg();
      await serviceWith(pg).listPayments();

      expect(listSql(pg)).toContain('79030169187');
    });

    it('includeTest снимает фильтр тестовых', async () => {
      const pg = fakePg();
      await serviceWith(pg).listPayments({ includeTest: true });

      expect(listSql(pg)).not.toContain('79030169187');
    });

    it('помечает строки тестовых аккаунтов, чтобы их было видно в таблице', async () => {
      const pg = fakePg({
        'FROM payments p': [
          { id: '1', phone: '79030169187', amount: '25.00', tokens: '1000000', status: 'succeeded', provider: 'priem', currency: 'USD' },
          { id: '2', phone: '79088644408', amount: '1990.00', tokens: '1000000', status: 'succeeded', provider: 'yookassa', currency: 'RUB' },
          { id: '3', phone: '79030001234', amount: '1990.00', tokens: '1000000', status: 'succeeded', provider: 'yookassa', currency: 'RUB' },
        ],
      });
      const rows = await serviceWith(pg).listPayments({ includeTest: true });

      expect(rows.map(r => r.is_test)).toEqual([true, false, true]);
      expect(rows[0].currency).toBe('USD');
      expect(rows[0].provider).toBe('priem');
    });

    it('старым строкам без provider/currency подставляет рублёвую YooKassa', async () => {
      const pg = fakePg({
        'FROM payments p': [
          { id: '1', phone: '79088644408', amount: '1990.00', tokens: '1000000', status: 'succeeded', provider: null, currency: null },
        ],
      });
      const rows = await serviceWith(pg).listPayments();

      expect(rows[0].provider).toBe('yookassa');
      expect(rows[0].currency).toBe('RUB');
    });

    it('фильтрует по статусу failed — он есть только у «Приёма»', async () => {
      const pg = fakePg();
      await serviceWith(pg).listPayments({ status: 'failed' });

      const call = pg.calls.find(c => c.sql.includes('FROM payments p'))!;
      expect(call.sql).toContain('p.status = $');
      expect(call.params).toContain('failed');
    });
  });

  describe('getPaymentsStats', () => {
    /** Ответы на оба агрегатных запроса: суммы по валютам и счётчики. */
    const statsRows = {
      'GROUP BY d.day': [
        { day: '2026-08-08', currency: 'RUB', revenue: '1990', succeeded_count: 1, pending_count: 0, canceled_count: 0, failed_count: 0 },
        { day: '2026-08-08', currency: 'USD', revenue: '50', succeeded_count: 2, pending_count: 0, canceled_count: 0, failed_count: 3 },
      ],
      "GROUP BY COALESCE(p.currency, 'RUB')": [
        { currency: 'RUB', revenue_all: '46079', revenue_30d: '12940', revenue_7d: '3980', revenue_today: '0' },
        { currency: 'USD', revenue_all: '50', revenue_30d: '50', revenue_7d: '50', revenue_today: '0' },
      ],
      'COUNT(DISTINCT user_id)': [
        {
          succeeded_count: 43, pending_count: 1, canceled_count: 126,
          failed_count: 12, total_count: 182, unique_payers: 30,
        },
      ],
    };

    it('не складывает доллары с рублями', async () => {
      const stats = await serviceWith(fakePg(statsRows)).getPaymentsStats();

      expect(stats.totals.revenue_all).toEqual({ RUB: 46079, USD: 50 });
      expect(stats.totals.revenue_30d).toEqual({ RUB: 12940, USD: 50 });
    });

    // Строки, залитые до «Приёма», могут иметь currency = NULL. Обе группы
    // приезжают под меткой RUB, и вторая не должна затирать первую.
    it('складывает рублёвые группы, а не теряет одну из них', async () => {
      const pg = fakePg({
        ...statsRows,
        "GROUP BY COALESCE(p.currency, 'RUB')": [
          { currency: null, revenue_all: '1990', revenue_30d: '0', revenue_7d: '0', revenue_today: '0' },
          { currency: 'RUB', revenue_all: '46079', revenue_30d: '0', revenue_7d: '0', revenue_today: '0' },
        ],
      });
      const stats = await serviceWith(pg).getPaymentsStats();

      expect(stats.currencies).toEqual(['RUB']);
      expect(stats.totals.revenue_all).toEqual({ RUB: 48069 });
    });

    it('перечисляет валюты, которые реально встретились', async () => {
      const stats = await serviceWith(fakePg(statsRows)).getPaymentsStats();

      expect(stats.currencies).toEqual(['RUB', 'USD']);
    });

    it('в дневном ряду тоже держит валюты порознь, а счётчики складывает', async () => {
      const stats = await serviceWith(fakePg(statsRows)).getPaymentsStats();

      expect(stats.daily).toHaveLength(1);
      expect(stats.daily[0].revenue).toEqual({ RUB: 1990, USD: 50 });
      expect(stats.daily[0].succeeded).toBe(3);
      expect(stats.daily[0].failed).toBe(3);
    });

    it('считает failed — до этого он не попадал ни в один счётчик', async () => {
      const stats = await serviceWith(fakePg(statsRows)).getPaymentsStats();

      expect(stats.totals.failed_count).toBe(12);
      const { succeeded_count, pending_count, canceled_count, failed_count, total_count } = stats.totals;
      expect(succeeded_count + pending_count + canceled_count + failed_count).toBe(total_count);
    });

    it('по умолчанию считает выручку без тестовых, с includeTest — вместе с ними', async () => {
      const clean = fakePg(statsRows);
      await serviceWith(clean).getPaymentsStats();
      expect(clean.calls.every(c => c.sql.includes('79030169187'))).toBe(true);

      const dirty = fakePg(statsRows);
      await serviceWith(dirty).getPaymentsStats({ includeTest: true });
      expect(dirty.calls.some(c => c.sql.includes('79030169187'))).toBe(false);
    });

    it('сообщает фронту, в каком режиме посчитаны цифры', async () => {
      const off = await serviceWith(fakePg(statsRows)).getPaymentsStats();
      const on = await serviceWith(fakePg(statsRows)).getPaymentsStats({ includeTest: true });

      expect(off.include_test).toBe(false);
      expect(on.include_test).toBe(true);
    });
  });
});
