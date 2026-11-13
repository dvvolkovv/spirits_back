import 'reflect-metadata';
import { readFileSync } from 'fs';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { DELETION_DISCOVERERS } from '../account-deletion/account-deletion.catalog';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DeletionRetryError } from '../account-deletion/account-deletion.safe';
import type { DeletionJobRow } from '../account-deletion/account-deletion.types';
import { ProductsModule } from './products.module';
import {
  discoverProductDeletion,
  ProductAccountDeletionAdapter,
} from './product-account-deletion.adapter';
import { ProductAccountDeletionService } from './product-account-deletion.service';

const DELETION_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';

function job(): DeletionJobRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    deletionId: DELETION_ID,
    userId: 'u-deleted',
    resourceType: 'product.stop',
    resourceKey: PRODUCT_ID,
    phase: 'immediate',
    payload: { productId: PRODUCT_ID, slug: 'slug-1', hostId: 'host-shared' },
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-01T00:00:00.000Z'),
    leaseUntil: new Date('2026-11-01T00:05:00.000Z'),
    lastErrorKind: null,
  };
}

function harness(status: string | null = 'queued') {
  const products = { stop: jest.fn(async () => status) };
  const registry = new AccountDeletionRegistry();
  const adapter = new ProductAccountDeletionAdapter(products as any, registry);
  const ctx = {
    db: { query: jest.fn() },
    assertCurrent: jest.fn(async () => undefined),
  };
  return { adapter, products, registry, ctx };
}

describe('product account deletion discovery', () => {
  const PURGED_ID = '66666666-6666-4666-8666-666666666666';

  it('создаёт product.stop нестёртым и product.purge ВСЕМ продуктам поколения', async () => {
    const db = { query: jest.fn(async () => ({
      rows: [
        { id: PRODUCT_ID, slug: 'slug-1', host_id: 'host-shared', purged_at: null },
        // Уже стёрт штатным обходом до удаления аккаунта: stop не нужен,
        // а строка и журнал должны чиститься — purge-job обязателен.
        { id: PURGED_ID, slug: 'slug-2', host_id: null, purged_at: new Date('2026-10-15T00:00:00.000Z') },
      ],
      rowCount: 2,
    })) };
    const account = {
      userId: 'u-deleted',
      deletionId: DELETION_ID,
      deletedAt: new Date('2026-11-01T00:00:00.000Z'),
    };

    const plan = await discoverProductDeletion({ db, account, origin: 'merge' });

    expect(plan).toEqual({
      jobs: [
        {
          resourceType: 'product.stop',
          resourceKey: PRODUCT_ID,
          phase: 'immediate',
          payload: { productId: PRODUCT_ID, slug: 'slug-1', hostId: 'host-shared' },
        },
        {
          resourceType: 'product.purge',
          resourceKey: PRODUCT_ID,
          phase: 'purge',
          payload: { productId: PRODUCT_ID, slug: 'slug-1', hostId: 'host-shared' },
        },
        {
          resourceType: 'product.purge',
          resourceKey: PURGED_ID,
          phase: 'purge',
          payload: { productId: PURGED_ID, slug: 'slug-2', hostId: null },
        },
      ],
      skips: [],
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('p.user_id=$1');
    expect(sql).toContain("u.state='deleted'");
    expect(sql).toContain('u.deletion_id=$2');
    // Поколение отбирается БЕЗ фильтра purged_at — стёртые видны purge-ветке.
    expect(sql).toContain('p.purged_at');
    expect(sql).not.toMatch(/AND p\.purged_at IS NULL/);
    expect(params).toEqual(['u-deleted', DELETION_ID]);
    expect(DELETION_DISCOVERERS.filter((item) => item === discoverProductDeletion)).toHaveLength(1);
  });
});

describe('ProductAccountDeletionAdapter', () => {
  it.each(['queued', 'running', 'failed', null])(
    'sleep %s не считается остановкой и сохраняет payload для retry',
    async (status) => {
      const { adapter, products, ctx } = harness(status);
      const value = job();
      const payload = JSON.parse(JSON.stringify(value.payload));

      await expect(adapter.execute(value, ctx)).rejects.toEqual(
        new DeletionRetryError('external_unknown'),
      );
      expect(ctx.assertCurrent).toHaveBeenCalledWith(value);
      expect(products.stop).toHaveBeenCalledWith(PRODUCT_ID, 'u-deleted', DELETION_ID);
      expect(value.payload).toEqual(payload);
    },
  );

  it('только подтверждённый done завершает stop', async () => {
    const { adapter, ctx } = harness('done');
    await expect(adapter.execute(job(), ctx)).resolves.toBeUndefined();
  });

  it('resourceTypes включает stop и purge, registry регистрируется один раз', () => {
    const { adapter, registry } = harness();
    expect(adapter.resourceTypes).toEqual(['product.stop', 'product.purge']);
    const register = jest.spyOn(registry, 'register');
    adapter.onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(adapter);
    expect(registry.getExecutor('product.stop')).toBe(adapter);
    expect(registry.getExecutor('product.purge')).toBe(adapter);
  });

  it('adapter/service не импортируют прямой host runner, а BlockService делит forced-stop helper', () => {
    const adapterSource = readFileSync(`${__dirname}/product-account-deletion.adapter.ts`, 'utf8');
    const serviceSource = readFileSync(`${__dirname}/product-account-deletion.service.ts`, 'utf8');
    const blockSource = readFileSync(`${__dirname}/block.service.ts`, 'utf8');
    for (const source of [adapterSource, serviceSource]) {
      expect(source).not.toMatch(/node:child_process|child_process|\bssh\b|\bdocker\b/);
    }
    expect(adapterSource).not.toContain('ProvisioningService');
    expect(serviceSource).toContain("from './product-forced-stop'");
    expect(blockSource).toContain("from './product-forced-stop'");
  });

  it('ProductsModule подключает AccountDeletionModule и оба provider ровно один раз без assertReady', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ProductsModule) ?? [];
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProductsModule) ?? [];
    expect(imports.filter((item: unknown) => item === AccountDeletionModule)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === ProductAccountDeletionService)).toHaveLength(1);
    expect(providers.filter((item: unknown) => item === ProductAccountDeletionAdapter)).toHaveLength(1);
    const moduleSource = readFileSync(`${__dirname}/products.module.ts`, 'utf8');
    expect(moduleSource).not.toContain('assertReady');
    expect(moduleSource).not.toContain('AccountDeletionRunner');
  });
});

/**
 * Task 8 — product.purge: матриса ветвей fail-closed на моках фасада
 * (ProductAccountDeletionService). Полные потоки против живой базы —
 * product-account-deletion.pg.spec.ts; здесь только диспетчеризация и ветви.
 */
describe('ProductAccountDeletionAdapter — product.purge', () => {
  const PURGED_AT = new Date('2026-11-10T00:00:00.000Z');

  function purgeHarness(
    state: { owned: boolean; purgedAt: Date | null; repoUrl: string | null } | null,
    opts: { cleared?: boolean; deleted?: boolean } = {},
  ) {
    const products = {
      stop: jest.fn(async () => 'done'),
      wipeExpiredForProduct: jest.fn(async () => 0),
      queuePurgeForProduct: jest.fn(async () => 1),
      purgeState: jest.fn(async () => state),
      removeBackupForProduct: jest.fn(async () => 0),
      backupCleared: jest.fn(async () => opts.cleared ?? true),
      deletePurgedProduct: jest.fn(async () => opts.deleted ?? true),
    };
    const registry = new AccountDeletionRegistry();
    const adapter = new ProductAccountDeletionAdapter(products as any, registry);
    const ctx = {
      db: { query: jest.fn() },
      assertCurrent: jest.fn(async () => undefined),
    };
    return { adapter, products, ctx };
  }

  function purgeRow(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
    return {
      ...job(),
      id: '99999999-9999-4999-8999-999999999999',
      resourceType: 'product.purge',
      phase: 'purge',
      ...overrides,
    };
  }

  it('purge не подтверждён (purged_at null) — fail-closed retry, удаления нет, payload цел', async () => {
    const { adapter, products, ctx } = purgeHarness({ owned: true, purgedAt: null, repoUrl: null });
    const value = purgeRow();
    const payload = JSON.parse(JSON.stringify(value.payload));

    await expect(adapter.execute(value, ctx)).rejects.toEqual(new DeletionRetryError('external_unknown'));

    expect(products.wipeExpiredForProduct).toHaveBeenCalledWith(PRODUCT_ID, 'u-deleted');
    expect(products.queuePurgeForProduct).toHaveBeenCalledWith(PRODUCT_ID, 'u-deleted');
    expect(products.removeBackupForProduct).not.toHaveBeenCalled();
    expect(products.deletePurgedProduct).not.toHaveBeenCalled();
    expect(value.payload).toEqual(payload);
  });

  it('подтверждённый purge — scoped-шаги по порядку, assertCurrent между ними, удаление последним', async () => {
    const { adapter, products, ctx } = purgeHarness({ owned: true, purgedAt: PURGED_AT, repoUrl: null });

    await expect(adapter.execute(purgeRow(), ctx)).resolves.toBeUndefined();

    expect(ctx.assertCurrent).toHaveBeenCalledTimes(4);
    expect(products.deletePurgedProduct).toHaveBeenCalledWith(PRODUCT_ID, 'u-deleted', DELETION_ID);
    // Без repo_url факт стирания копии не спрашивается.
    expect(products.backupCleared).not.toHaveBeenCalled();
    const order = [
      products.wipeExpiredForProduct,
      products.queuePurgeForProduct,
      products.purgeState,
      products.removeBackupForProduct,
      products.deletePurgedProduct,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('строка продукта уже отсутствует — подтверждённый успех без удаления (идемпотентность)', async () => {
    const { adapter, products, ctx } = purgeHarness(null);

    await expect(adapter.execute(purgeRow(), ctx)).resolves.toBeUndefined();

    expect(products.removeBackupForProduct).not.toHaveBeenCalled();
    expect(products.deletePurgedProduct).not.toHaveBeenCalled();
  });

  it('чужой продукт (owned=false) — fail-closed, удаления нет', async () => {
    const { adapter, products, ctx } = purgeHarness({ owned: false, purgedAt: PURGED_AT, repoUrl: null });

    await expect(adapter.execute(purgeRow(), ctx)).rejects.toEqual(new DeletionRetryError('external_unknown'));

    expect(products.deletePurgedProduct).not.toHaveBeenCalled();
  });

  it('резервная копия не стёрта — retry, строка переживает attempt', async () => {
    const { adapter, products, ctx } = purgeHarness(
      { owned: true, purgedAt: PURGED_AT, repoUrl: 'backup@10.0.0.1:/x/slug-1.git' },
      { cleared: false },
    );

    await expect(adapter.execute(purgeRow(), ctx)).rejects.toEqual(new DeletionRetryError('external_unknown'));

    expect(products.removeBackupForProduct).toHaveBeenCalledWith(PRODUCT_ID, 'u-deleted');
    expect(products.backupCleared).toHaveBeenCalledWith(PRODUCT_ID, 'u-deleted');
    expect(products.deletePurgedProduct).not.toHaveBeenCalled();
  });

  it('deletePurgedProduct отказал (стражи не прошли) — retry, а не успех', async () => {
    const { adapter, products, ctx } = purgeHarness(
      { owned: true, purgedAt: PURGED_AT, repoUrl: null },
      { deleted: false },
    );

    await expect(adapter.execute(purgeRow(), ctx)).rejects.toEqual(new DeletionRetryError('external_unknown'));

    expect(products.deletePurgedProduct).toHaveBeenCalled();
  });

  it('неизвестный resourceType — по-прежнему ошибка диспетчеризации', async () => {
    const { adapter, ctx } = purgeHarness(null);
    await expect(adapter.execute(purgeRow({ resourceType: 'telegram.purge' }), ctx)).rejects
      .toThrow('unsupported_deletion_resource');
  });
});
