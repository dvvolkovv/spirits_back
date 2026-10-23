import {
  SpendingService,
  clampMonths,
  groupMonths,
  DEFAULT_SPENDING_TZ,
} from './spending.service';

describe('clampMonths', () => {
  it('по умолчанию 12', () => {
    expect(clampMonths(undefined)).toBe(12);
    expect(clampMonths('')).toBe(12);
    expect(clampMonths('abc')).toBe(12);
  });
  it('прижимается к 1–24', () => {
    expect(clampMonths('0')).toBe(1);
    expect(clampMonths('-5')).toBe(1);
    expect(clampMonths('100')).toBe(24);
    expect(clampMonths('6')).toBe(6);
  });
});

describe('groupMonths', () => {
  const rows = [
    { month: '2026-06', category: 'replies', tokens: '250050', count: '63' },
    { month: '2026-10', category: 'replies', tokens: '6193', count: '12' },
    { month: '2026-06', category: 'images', tokens: '110000', count: '11' },
    { month: '2026-05', category: 'video', tokens: '50000', count: '2' },
    { month: '2026-05', category: 'other', tokens: '0', count: '1' },
  ];

  it('месяцы от нового к старому, категории по убыванию, итог — сумма', () => {
    expect(groupMonths(rows, 12)).toEqual([
      { month: '2026-10', total: 6193, categories: [{ key: 'replies', tokens: 6193, count: 12 }] },
      {
        month: '2026-06',
        total: 360050,
        categories: [
          { key: 'replies', tokens: 250050, count: 63 },
          { key: 'images', tokens: 110000, count: 11 },
        ],
      },
      { month: '2026-05', total: 50000, categories: [{ key: 'video', tokens: 50000, count: 2 }] },
    ]);
  });

  it('отрезает лишние месяцы — остаются самые новые', () => {
    expect(groupMonths(rows, 2).map((m) => m.month)).toEqual(['2026-10', '2026-06']);
  });

  it('месяц с одними нулями не попадает в ответ', () => {
    const r = groupMonths([{ month: '2026-01', category: 'other', tokens: '0', count: '3' }], 12);
    expect(r).toEqual([]);
  });
});

describe('SpendingService', () => {
  function makePg(zones: string[] = ['Europe/Moscow', 'UTC', 'Asia/Novosibirsk']) {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const pg = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (sql.includes('pg_timezone_names')) return { rows: zones.map((name) => ({ name })) };
        return { rows: [{ month: '2026-10', category: 'replies', tokens: '6193', count: '12' }] };
      }),
    };
    return { pg, calls };
  }

  it('известный пояс уходит в запрос как есть', async () => {
    const { pg } = makePg();
    expect(await new SpendingService(pg as any).resolveTz('Asia/Novosibirsk')).toBe('Asia/Novosibirsk');
  });

  it('неизвестный или пустой пояс — Москва', async () => {
    const { pg } = makePg();
    const svc = new SpendingService(pg as any);
    expect(await svc.resolveTz('Nowhere/Atlantis')).toBe(DEFAULT_SPENDING_TZ);
    expect(await svc.resolveTz(undefined)).toBe(DEFAULT_SPENDING_TZ);
    expect(await svc.resolveTz('')).toBe(DEFAULT_SPENDING_TZ);
  });

  it('список поясов читается один раз на процесс', async () => {
    const { pg, calls } = makePg();
    const svc = new SpendingService(pg as any);
    await svc.resolveTz('UTC');
    await svc.resolveTz('Europe/Moscow');
    expect(calls.filter((c) => c.sql.includes('pg_timezone_names'))).toHaveLength(1);
  });

  it('сбой чтения поясов — Москва, а не ошибка', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('boom'); }) };
    expect(await new SpendingService(pg as any).resolveTz('UTC')).toBe(DEFAULT_SPENDING_TZ);
  });

  it('monthly: только списания этого пользователя, месяц в поясе, категории из правил', async () => {
    const { pg, calls } = makePg();
    const r = await new SpendingService(pg as any).monthly('u-1', 'UTC', '6');
    const q = calls.find((c) => c.sql.includes('token_transactions'))!;
    expect(q.params).toEqual(['u-1', 'UTC']);
    expect(q.sql).toContain("transaction_type = 'consumed'");
    expect(q.sql).toContain('AT TIME ZONE $2');
    expect(q.sql).toContain("THEN 'images'");
    expect(r).toEqual([{ month: '2026-10', total: 6193, categories: [{ key: 'replies', tokens: 6193, count: 12 }] }]);
  });
});
