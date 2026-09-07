import { ConflictException } from '@nestjs/common';
import { TurnsService } from './turns.service';

function makeService(
  opts: {
    duplicate?: boolean;
    failWithCode?: string;
    productStatus?: string;
    balanceOk?: boolean;
  } = {},
) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT status FROM products')) {
        return { rows: [{ status: opts.productStatus ?? 'running' }] };
      }
      if (sql.includes('INSERT INTO product_turns') && opts.duplicate) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'product_turns_one_active',
        });
      }
      if (sql.includes('INSERT INTO product_turns') && opts.failWithCode) {
        throw Object.assign(new Error('boom'), { code: opts.failWithCode });
      }
      if (sql.includes('INSERT INTO product_turns')) {
        return { rows: [{ id: 't-1', status: 'queued' }] };
      }
      return { rows: [] };
    }),
  };
  const misc = {
    deductTokens: jest.fn(),
    checkTokenBalance: jest.fn(async () => ({ ok: opts.balanceOk ?? true })),
  };
  // Третьим аргументом идёт RedisService — он понадобится в Task 8 для буфера
  // событий. Заводим заглушку сразу, чтобы сигнатура не менялась по ходу плана.
  const redis = { rpush: jest.fn(), expire: jest.fn(), lrange: jest.fn(async () => []) };
  return { svc: new TurnsService(pg as any, misc as any, redis as any), calls, misc };
}

describe('TurnsService.enqueue', () => {
  it('создаёт ход в статусе queued', async () => {
    const { svc, calls } = makeService();

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'поправь футер' }),
    ).resolves.toMatchObject({ id: 't-1', status: 'queued' });

    // INSERT ищется по содержимому, а не по индексу: первым запросом идёт
    // проверка статуса продукта, и привязка к calls[0] сломается от любой
    // будущей вставки предусловия.
    const insert = calls.find((c) => c.sql.includes('INSERT INTO product_turns'))!;

    // Три утверждения о тексте нужны потому, что мок отдаёт захардкоженную
    // строку и ни на одну из этих подмен сам по себе не отреагирует. Каждая
    // подмена ломает тихо, без исключения и без строки в логе:
    //
    //   'queued' → 'running'     — claimNext ищет строго 'queued' и такой ход
    //                              не подберёт никогда, а замок будет считать
    //                              продукт занятым до сборщика через полчаса;
    //   перестановка колонок     — userId уезжает в product_id, ход повисает
    //   или плейсхолдеров          на несуществующем продукте, замок занимает
    //                              не тот продукт;
    //   усечение RETURNING       — наружу уходит объект без status, а его
    //                              отдают клиенту revert (Task 5) и chat
    //                              (Task 8).
    //
    // Колонки и плейсхолдеры охраняются раздельно: переставить можно любое из
    // двух, последствие одинаковое, а params при этом не меняется.
    expect(insert.sql).toContain('(product_id, user_id, channel, prompt, status)');
    expect(insert.sql).toContain('VALUES ($1, $2, $3, $4');
    expect(insert.sql).toContain("'queued'");
    expect(insert.sql).toContain('RETURNING id, status');
    expect(insert.params).toEqual(['p-1', 'u-1', 'web', 'поправь футер']);
  });

  it('второй ход по тому же продукту отбивается 409, а не 500', async () => {
    const { svc } = makeService({ duplicate: true });

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'ещё раз' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('ошибка, не связанная с замком, пробрасывается как есть', async () => {
    // Без этого теста безусловный ConflictException в catch проходит незамеченным,
    // и тогда падение базы, таймаут пула или нарушение CHECK приезжают клиенту
    // как «агент уже работает» — на продукте, где никто не работает. В логе при
    // этом пусто: ConflictException штатный 4xx, а не 5xx, и диагностика уходит
    // искать зависший ход, которого нет.
    const { svc } = makeService({ failWithCode: '23514' });

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'go' }),
    ).rejects.not.toBeInstanceOf(ConflictException);
  });

  it('ход на неработающем продукте не создаётся', async () => {
    const { svc, calls } = makeService({ productStatus: 'stopped' });

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'go' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(calls.some((c) => c.sql.includes('INSERT INTO product_turns'))).toBe(false);
  });

  it('при нулевом балансе ход не создаётся', async () => {
    const { svc, calls } = makeService({ balanceOk: false });

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'go' }),
    ).rejects.toThrow();

    // Ход = реальный запуск claude -p на VM, то есть живые деньги. Вставка не
    // должна происходить вовсе, а не «происходить и не тарифицироваться».
    expect(calls.some((c) => c.sql.includes('INSERT INTO product_turns'))).toBe(false);
  });
});
