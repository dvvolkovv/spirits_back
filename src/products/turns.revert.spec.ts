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
  const redis = { rpush: jest.fn(), expire: jest.fn(), lrange: jest.fn(async () => []) };
  return { svc: new TurnsService(pg as any, misc as any, redis as any), calls };
}

describe('TurnsService.revert', () => {
  it('ставит служебный ход отката на sha_before выбранного хода', async () => {
    const { svc, calls } = makeService({ id: 't-1', sha_before: 'aaa111' });

    await svc.revert({ productId: 'p-1', turnId: 't-1', userId: 'u-1' });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO product_turns'))!;
    // sha_before целевого хода уезжает в новый ход как точка возврата — но
    // не отдельным параметром, а встроенным в prompt ("__revert__:aaa111").
    // `toContain` на массиве требует точного совпадения элемента, поэтому
    // прямое `expect(insert.params).toContain('aaa111')` красное всегда,
    // независимо от корректности реализации — проверяем подстроку явно.
    expect(insert.params.some((p) => typeof p === 'string' && p.includes('aaa111'))).toBe(true);
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
