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
  it('создаёт только product.stop с техническими slug/host и owner+generation predicates', async () => {
    const db = { query: jest.fn(async () => ({
      rows: [{ id: PRODUCT_ID, slug: 'slug-1', host_id: 'host-shared' }],
      rowCount: 1,
    })) };
    const account = {
      userId: 'u-deleted',
      deletionId: DELETION_ID,
      deletedAt: new Date('2026-11-01T00:00:00.000Z'),
    };

    const plan = await discoverProductDeletion({ db, account, origin: 'merge' });

    expect(plan).toEqual({
      jobs: [{
        resourceType: 'product.stop',
        resourceKey: PRODUCT_ID,
        phase: 'immediate',
        payload: { productId: PRODUCT_ID, slug: 'slug-1', hostId: 'host-shared' },
      }],
      skips: [],
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('p.user_id=$1');
    expect(sql).toContain("u.state='deleted'");
    expect(sql).toContain('u.deletion_id=$2');
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

  it('resourceTypes не включает Task 8 purge, registry регистрируется один раз', () => {
    const { adapter, registry } = harness();
    expect(adapter.resourceTypes).toEqual(['product.stop']);
    const register = jest.spyOn(registry, 'register');
    adapter.onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(adapter);
    expect(registry.getExecutor('product.stop')).toBe(adapter);
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
