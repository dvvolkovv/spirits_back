import { BalanceContextService } from './balance-context.service';

/** Фейковый PgService: отдаёт заготовленные ответы и записывает все запросы. */
function fakePg(opts: {
  warned?: { at: string; atBalance: number } | null;
  spends?: number[];
} = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  return {
    calls,
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/low_balance_warned|profile_data/.test(sql) && /SELECT/i.test(sql)) {
        return { rows: [{ warned: opts.warned ?? null }] };
      }
      if (/token_transactions/.test(sql)) {
        return { rows: (opts.spends ?? []).map((a) => ({ amount: a })) };
      }
      return { rows: [] };
    },
  } as any;
}

const svc = (pg: any) => new BalanceContextService(pg);

describe('BalanceContextService — постоянная часть блока', () => {
  it('называет точную цифру баланса', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 43210);
    expect(block).toContain('43210');
  });

  it('запрещает заговаривать о балансе первым', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 43210);
    expect(block).toContain('Сам про баланс не заговаривай');
  });

  it('объясняет, что делать с отказом инструмента', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 43210);
    expect(block).toContain('insufficient_tokens');
    expect(block).toContain('https://my.linkeon.io/chat?view=tokens');
  });
});

describe('BalanceContextService — прогноз остатка', () => {
  it('баланс выше 30 000 — за медианой в базу не ходим', async () => {
    const pg = fakePg({ spends: [300, 300, 300, 300, 300] });
    await svc(pg).buildContextForPrompt('u1', 43210);
    expect(pg.calls.some((c: any) => /token_transactions/.test(c.sql))).toBe(false);
  });

  it('баланс ниже 30 000 и статистики хватает — пишем прогноз', async () => {
    const pg = fakePg({ spends: [300, 400, 400, 400, 500] });
    const block = await svc(pg).buildContextForPrompt('u1', 8000);
    // 8000 / 400 = 20 сообщений
    expect(block).toContain('20');
    expect(block).toContain('примерно');
  });

  it('статистики не хватает — прогноза нет, цифра остаётся', async () => {
    const block = await svc(fakePg({ spends: [300, 400] })).buildContextForPrompt('u1', 8000);
    expect(block).toContain('8000');
    expect(block).not.toContain('примерно');
  });

  it('берёт из БД величины, а не знаковые суммы — иначе прогноз молча пропадёт', async () => {
    // Расход в token_transactions лежит отрицательным числом, а medianSpend
    // отбрасывает неположительные значения. Без ABS в SQL ни один замер не
    // доедет, прогноз исчезнет навсегда, и ни один другой тест не покраснеет.
    const pg = fakePg({ spends: [300, 400, 400, 400, 500] });
    await svc(pg).buildContextForPrompt('u1', 8000);
    const q = pg.calls.find((c: any) => /token_transactions/.test(c.sql));
    expect(q.sql).toMatch(/ABS\s*\(\s*amount\s*\)/i);
  });
});

describe('BalanceContextService — разрешение предупредить', () => {
  it('баланс ниже порога, не предупреждали — разрешение выдано', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 8000);
    expect(block).toContain('Баланс на исходе');
    expect(block).toContain('Пополнить баланс');
  });

  it('баланс выше порога — разрешения нет', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 43210);
    expect(block).not.toContain('Баланс на исходе');
  });

  it('уже предупреждали час назад — разрешения нет', async () => {
    const at = new Date(Date.now() - 3600_000).toISOString();
    const pg = fakePg({ warned: { at, atBalance: 9000 } });
    const block = await svc(pg).buildContextForPrompt('u1', 8000);
    expect(block).not.toContain('Баланс на исходе');
  });

  it('приветствие — разрешения нет', async () => {
    const block = await svc(fakePg()).buildContextForPrompt('u1', 500, { isGreeting: true });
    expect(block).not.toContain('Баланс на исходе');
  });

  it('выдав разрешение, ставит отметку в profile_data', async () => {
    const pg = fakePg();
    await svc(pg).buildContextForPrompt('u1', 8000);
    const write = pg.calls.find((c: any) => /UPDATE/i.test(c.sql) && /low_balance_warned/.test(c.sql));
    expect(write).toBeDefined();
  });

  it('не выдав разрешения, отметку не трогает', async () => {
    const pg = fakePg();
    await svc(pg).buildContextForPrompt('u1', 43210);
    const write = pg.calls.find((c: any) => /UPDATE/i.test(c.sql));
    expect(write).toBeUndefined();
  });
});

describe('BalanceContextService — устойчивость', () => {
  it('падение базы не роняет ход: блок пустой, исключения нет', async () => {
    const pg = { query: async () => { throw new Error('db down'); } } as any;
    await expect(svc(pg).buildContextForPrompt('u1', 8000)).resolves.toBe('');
  });
});
