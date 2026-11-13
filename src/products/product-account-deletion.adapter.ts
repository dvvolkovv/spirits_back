import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DeletionRetryError } from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscoverer,
  DeletionExecution,
  DeletionJobRow,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { ProductAccountDeletionService } from './product-account-deletion.service';

/** Read-only discovery одного поколения; purge discovery появится отдельно в Task 8. */
export const discoverProductDeletion: DeletionDiscoverer = async ({ db, account }) => {
  const products = await db.query(
    `SELECT p.id,p.slug,p.host_id
       FROM products p
       JOIN user_id u ON u.internal_id=p.user_id
      WHERE p.user_id=$1
        AND u.state='deleted' AND u.deletion_id=$2
        AND p.purged_at IS NULL
      ORDER BY p.id`,
    [account.userId, account.deletionId],
  );
  return {
    jobs: products.rows.map((row) => {
      const productId = String(row.id);
      return {
        resourceType: 'product.stop' as const,
        resourceKey: productId,
        phase: 'immediate' as const,
        payload: {
          productId,
          slug: String(row.slug),
          hostId: row.host_id == null ? null : String(row.host_id),
        },
      };
    }),
    skips: [],
  };
};

@Injectable()
export class ProductAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['product.stop'];

  constructor(
    private readonly products: ProductAccountDeletionService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'product.stop') throw new Error('unsupported_deletion_resource');
    await ctx.assertCurrent(job);
    const sleep = await this.products.stop(job.resourceKey, job.userId, job.deletionId);
    // queued/running/failed/отсутствие после repair — внешний результат ещё не
    // подтверждён. Job payload не меняется и остаётся следующему attempt.
    if (sleep !== 'done') throw new DeletionRetryError('external_unknown');
  }
}
