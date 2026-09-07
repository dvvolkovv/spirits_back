import { BadRequestException } from '@nestjs/common';
import { TurnsService } from './turns.service';

function makeService(target: any) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id, sha_before')) return { rows: target ? [target] : [] };
      if (sql.includes('SELECT status FROM products')) return { rows: [{ status: 'running' }] };
      if (sql.includes('INSERT INTO product_turns')) return { rows: [{ id: 't-revert', status: 'queued' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const misc = { deductTokens: jest.fn(), checkTokenBalance: jest.fn(async () => ({ ok: true })) };
  return { svc: new TurnsService(pg as any, misc as any), calls };
}

describe('TurnsService.revert', () => {
  it('ставит служебный ход отката на sha_before выбранного хода', async () => {
    const { svc, calls } = makeService({ id: 't-1', sha_before: 'aaa111' });

    // Возврат идёт наружу: Task 8 отдаёт его клиенту как `202 + тело`, и без
    // него кнопка «откат поставлен» не покажет поставленный ход.
    await expect(svc.revert({ productId: 'p-1', turnId: 't-1', userId: 'u-1' })).resolves.toMatchObject({
      id: 't-revert',
    });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO product_turns'))!;
    // Точка возврата уезжает отдельной колонкой, а не подстрокой в prompt.
    // Это и есть защита от подделки отката через обычный чат.
    expect(insert.params[4]).toBe('aaa111');
    // Что именно revert передаёт в enqueue, охраняется отдельно. Без этого
    // опечатка `productId: input.turnId` вставит turnId в колонку product_id:
    // ход повиснет на несуществующем продукте, а мьютекс займёт не тот. И без
    // проверки channel подмена на значение вне CHECK (channel IN
    // ('web','telegram')) даст 500 на живой базе, но зелёный юнит-прогон.
    expect(insert.params.slice(0, 3)).toEqual(['p-1', 'u-1', 'web']);
    // Ход ищется в пределах своего продукта. Без product_id в WHERE клиент
    // откатит чужой продукт на его же sha, передав чужой turnId — владение
    // проверено на уровне продукта, а сам ход взят по голому id.
    const select = calls.find((c) => c.sql.includes('SELECT id, sha_before'))!;
    expect(select.sql).toContain('product_id = $2');
  });

  it('ход без sha_before откатить нельзя', async () => {
    const { svc } = makeService({ id: 't-1', sha_before: null });

    await expect(svc.revert({ productId: 'p-1', turnId: 't-1', userId: 'u-1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('несуществующий ход не откатывается', async () => {
    const { svc } = makeService(null);

    await expect(svc.revert({ productId: 'p-1', turnId: 'nope', userId: 'u-1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
