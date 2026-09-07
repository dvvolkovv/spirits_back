import { ConflictException } from '@nestjs/common';
import { TurnsService } from './turns.service';

function makeService(opts: { duplicate?: boolean } = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO product_turns') && opts.duplicate) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'product_turns_one_active',
        });
      }
      if (sql.includes('INSERT INTO product_turns')) {
        return { rows: [{ id: 't-1', status: 'queued' }] };
      }
      return { rows: [] };
    }),
  };
  // Третьим аргументом идёт RedisService — он понадобится в Task 8 для буфера
  // событий. Заводим заглушку сразу, чтобы сигнатура не менялась по ходу плана.
  const redis = { rpush: jest.fn(), expire: jest.fn(), lrange: jest.fn(async () => []) };
  return { svc: new TurnsService(pg as any, { deductTokens: jest.fn() } as any, redis as any), calls };
}

describe('TurnsService.enqueue', () => {
  it('создаёт ход в статусе queued', async () => {
    const { svc, calls } = makeService();

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'поправь футер' }),
    ).resolves.toMatchObject({ id: 't-1', status: 'queued' });

    // Утверждение о тексте обязательно: мок отдаёт захардкоженный статус и на
    // подмену 'queued' на 'running' в INSERT не отреагирует. А подмена тихо
    // ломает всё: claimNext ищет строго 'queued' и такой ход не подберёт
    // никогда, продукт при этом останется занятым для замка — до сборщика
    // зависших через полчаса. Ни ошибки, ни строки в логе.
    expect(calls[0].sql).toContain("'queued'");
    // Порядок плейсхолдеров — тоже поведение. Перестановка $1 и $2 местами
    // запишет userId в product_id, а productId в user_id: ход повиснет на
    // несуществующем продукте, замок займёт не тот продукт, а внешний ключ
    // не спасёт — оба значения строковые. Список params при такой подмене не
    // меняется, поэтому ловится только текстом.
    expect(calls[0].sql).toContain('VALUES ($1, $2, $3, $4');
    expect(calls[0].params).toEqual(['p-1', 'u-1', 'web', 'поправь футер']);
  });

  it('второй ход по тому же продукту отбивается 409, а не 500', async () => {
    const { svc } = makeService({ duplicate: true });

    await expect(
      svc.enqueue({ productId: 'p-1', userId: 'u-1', channel: 'web', prompt: 'ещё раз' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
