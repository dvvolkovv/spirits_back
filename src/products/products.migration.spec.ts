import { ProductsService } from './products.service';

function makeService() {
  const queries: string[] = [];
  const pg = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    }),
  };
  return { svc: new ProductsService(pg as any), queries };
}

describe('ProductsService.onModuleInit', () => {
  it('накатывает схему products и product_turns', async () => {
    const { svc, queries } = makeService();

    await svc.onModuleInit();

    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS products');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS product_turns');
  });

  it('создаёт замок «один активный ход на продукт»', async () => {
    const { svc, queries } = makeService();

    await svc.onModuleInit();

    expect(queries.join('\n')).toContain('product_turns_one_active');
  });

  it('не падает, если применение миграции бросает ошибку', async () => {
    const pg = {
      query: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    const svc = new ProductsService(pg as any);

    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('миграция 002', () => {
  it('применяется вслед за 001', async () => {
    const applied: string[] = [];
    const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
    const svc = new ProductsService(pg as any);
    (svc as any).applyMigration = jest.fn(async (f: string) => void applied.push(f));

    await svc.onModuleInit();

    // Порядок важен: 002 добавляет колонки в таблицу, которую создаёт 001.
    expect(applied).toEqual(['001_products.sql', '002_provisioning.sql']);
  });

  it('заводит форму продукта, порт, секреты и очередь заданий', async () => {
    const { svc, queries } = makeService();

    await svc.onModuleInit();

    const sql = queries.join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS kind');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS port');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS secrets_encrypted');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS provision_error');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS product_provision_jobs');
    expect(sql).toContain('product_provision_jobs_one_active');
  });
});
