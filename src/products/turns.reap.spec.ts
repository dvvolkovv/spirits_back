import { TurnsService } from './turns.service';

function makeService(reaped: any[] = []) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows: reaped, rowCount: reaped.length };
    }),
  };
  const deductTokens = jest.fn();
  const misc = { deductTokens, checkTokenBalance: jest.fn(async () => ({ ok: true })) };
  return { svc: new TurnsService(pg as any, misc as any), calls, deductTokens };
}

describe('TurnsService.reapStuck', () => {
  it('переводит зависшие running-ходы в failed', async () => {
    const { svc, calls } = makeService([{ id: 't-1' }]);

    await svc.reapStuck();

    const sql = calls[0].sql;
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain('started_at <');
  });

  it('не трогает ходы, начатые только что', async () => {
    const { svc, calls } = makeService([]);

    await svc.reapStuck();

    // Порог в запросе, а не в коде: иначе «зависшим» окажется любой живой ход
    // длиннее одного тика планировщика.
    expect(calls[0].sql).toMatch(/interval/i);
  });

  it('зависший ход не тарифицируется', async () => {
    const { svc, deductTokens } = makeService([{ id: 't-1' }]);

    await svc.reapStuck();

    expect(deductTokens).not.toHaveBeenCalled();
  });
});
