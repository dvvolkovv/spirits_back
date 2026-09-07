import { NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';

const ROW = {
  id: 'p-1',
  user_id: '79030169187',
  name: 'selyanska',
  slug: 'selyanska',
  status: 'running',
  checkout_path: '/home/dv/selyanska',
};

function makeService(rows: any[]) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows };
    }),
  };
  return { svc: new ProductsService(pg as any), calls };
}

describe('ProductsService.list', () => {
  it('фильтрует по владельцу и не отдаёт архивные', async () => {
    const { svc, calls } = makeService([ROW]);

    await svc.list('79030169187');

    expect(calls[0].params).toEqual(['79030169187']);
    expect(calls[0].sql).toContain('archived_at IS NULL');
  });
});

describe('ProductsService.getOwned', () => {
  it('отдаёт продукт своему владельцу', async () => {
    const { svc } = makeService([ROW]);

    await expect(svc.getOwned('p-1', '79030169187')).resolves.toMatchObject({ id: 'p-1' });
  });

  it('чужой продукт не отличим от несуществующего', async () => {
    const { svc, calls } = makeService([]);

    await expect(svc.getOwned('p-1', '70000000000')).rejects.toBeInstanceOf(NotFoundException);
    // Владелец в WHERE, а не в проверке после выборки: иначе existence чужого
    // продукта утекает через разницу между 403 и 404.
    expect(calls[0].params).toEqual(['p-1', '70000000000']);
  });
});
