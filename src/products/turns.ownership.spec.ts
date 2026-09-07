import { NotFoundException } from '@nestjs/common';
import { TurnsService } from './turns.service';

function makeService(found: boolean) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
    }),
  };
  const misc = { deductTokens: jest.fn(), checkTokenBalance: jest.fn(async () => ({ ok: true })) };
  const redis = { rpush: jest.fn(), expire: jest.fn(), lrange: jest.fn(async () => []) };
  return { svc: new TurnsService(pg as any, misc as any, redis as any), calls };
}

describe('TurnsService.assertTurnBelongsTo', () => {
  it('свой ход проходит', async () => {
    const { svc, calls } = makeService(true);

    await expect(svc.assertTurnBelongsTo('t-1', 'p-1')).resolves.toBeUndefined();

    expect(calls[0].sql).toContain('id = $1');
    expect(calls[0].sql).toContain('product_id = $2');
    expect(calls[0].params).toEqual(['t-1', 'p-1']);
  });

  it('чужой ход — 404', async () => {
    const { svc } = makeService(false);

    await expect(svc.assertTurnBelongsTo('t-1', 'p-2')).rejects.toBeInstanceOf(NotFoundException);
  });
});
