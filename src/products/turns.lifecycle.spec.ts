import { TurnsService } from './turns.service';

function makeService(rows: Record<string, any[]> = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const deductTokens = jest.fn(async () => 0);
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SET status = 'running'")) return { rows: rows.claim ?? [{ id: 't-1', prompt: 'go' }] };
      return { rows: [] };
    }),
  };
  const redis = { rpush: jest.fn(), expire: jest.fn(), lrange: jest.fn(async () => []) };
  return {
    svc: new TurnsService(pg as any, { deductTokens, checkTokenBalance: jest.fn(async () => ({ ok: true })) } as any, redis as any),
    calls,
    deductTokens,
  };
}

const sqlOf = (calls: { sql: string }[]) => calls.map((c) => c.sql).join('\n');

describe('TurnsService.claimNext', () => {
  it('забирает ровно один queued-ход и переводит его в running', async () => {
    const { svc, calls } = makeService();

    const turn = await svc.claimNext('p-1');

    expect(turn).toMatchObject({ id: 't-1' });
    // Отбор — не косметика: без product_id раннер одного продукта заберёт ход
    // чужого и пойдёт править не тот чекаут, а без status='queued' подхватит
    // уже выполняющийся ход.
    expect(sqlOf(calls)).toContain('product_id = $1');
    expect(sqlOf(calls)).toContain("status = 'queued'");
    expect(sqlOf(calls)).toContain('FOR UPDATE SKIP LOCKED');
    expect(sqlOf(calls)).toContain('LIMIT 1');
  });

  it('отдаёт null, когда очередь пуста', async () => {
    const { svc } = makeService({ claim: [] });

    await expect(svc.claimNext('p-1')).resolves.toBeNull();
  });
});

describe('TurnsService.complete', () => {
  it('успешный ход списывает токены', async () => {
    const { svc, calls, deductTokens } = makeService();

    await svc.complete('t-1', {
      userId: 'u-1',
      status: 'done',
      result: 'готово',
      shaBefore: 'aaa',
      shaAfter: 'bbb',
      tokens: 1200,
    });

    expect(deductTokens).toHaveBeenCalledWith('u-1', 1200, expect.stringContaining('product'));

    // Без утверждения о WHERE подмена `id = $1` на `id = $2` проходит мимо
    // всех тестов: мок игнорирует текст, а проверяется только вызов
    // deductTokens, который от этого не зависит. Последствие — исход хода
    // записывается не в ту строку либо никуда, ход остаётся running, и замок
    // держит продукт до сборщика через полчаса.
    expect(calls[0].sql).toContain('WHERE id = $1');
    // COALESCE хранит уже записанный sha_before, когда раннер его не прислал.
    // Без него откат теряет точку возврата, а кнопка «вернуть как было»
    // перестаёт работать на ходах, доложенных без shaBefore.
    expect(calls[0].sql).toContain('COALESCE($5, sha_before)');
    expect(calls[0].sql).toContain('tokens_spent = $7');
  });

  it('отрицательные токены от раннера не уходят в базу', async () => {
    const { svc, calls, deductTokens } = makeService();

    await svc.complete('t-1', { userId: 'u-1', status: 'done', tokens: -5 });

    // Кламп существует потому, что тело запроса раннера — TS-тип при
    // ValidationPipe({whitelist:false}), то есть рантайм-проверки нет вовсе.
    // Без клампа сюда прилетает 23514 от CHECK (tokens_spent >= 0), уходит
    // наружу необработанным 500, ход остаётся running и держит замок.
    expect(calls[0].params[6]).toBe(0);
    expect(deductTokens).not.toHaveBeenCalled();
  });

  it('упавший ход не тарифицируется', async () => {
    const { svc, deductTokens } = makeService();

    await svc.complete('t-1', { userId: 'u-1', status: 'failed', error: 'claude exited 1', tokens: 900 });

    expect(deductTokens).not.toHaveBeenCalled();
  });

  it('откат по health-check не тарифицируется', async () => {
    const { svc, deductTokens } = makeService();

    await svc.complete('t-1', { userId: 'u-1', status: 'reverted', shaBefore: 'aaa', tokens: 900 });

    expect(deductTokens).not.toHaveBeenCalled();
  });
});
