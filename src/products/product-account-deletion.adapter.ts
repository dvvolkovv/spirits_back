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
  readonly resourceTypes: readonly DeletionResourceType[] = ['product.stop', 'product.purge'];

  constructor(
    private readonly products: ProductAccountDeletionService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType === 'product.stop') return this.stopProduct(job, ctx);
    if (job.resourceType === 'product.purge') return this.purgeProduct(job, ctx);
    throw new Error('unsupported_deletion_resource');
  }

  private async stopProduct(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    await ctx.assertCurrent(job);
    const sleep = await this.products.stop(job.resourceKey, job.userId, job.deletionId);
    // queued/running/failed/отсутствие после repair — внешний результат ещё не
    // подтверждён. Job payload не меняется и остаётся следующему attempt.
    if (sleep !== 'done') throw new DeletionRetryError('external_unknown');
  }

  /**
   * Task 8 — product.purge. Relational-строки продукта (сам продукт, turns,
   * jobs, domains, журнал) удаляются ТОЛЬКО после того, как агент машины
   * pull-модели подтвердил стирание (products.purged_at) — до подтверждения
   * каждый attempt лишь повторяет scoped-подготовку (wipe, постановка
   * host-задания, стирание резервной копии) и уходит в fail-closed retry.
   * Между шагами — assertCurrent: отмена удаления или смена поколения
   * прерывает цепочку (DeletionCancelledError). Payload не мутируется.
   */
  private async purgeProduct(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    await ctx.assertCurrent(job);
    await this.products.wipeExpiredForProduct(job.resourceKey, job.userId);

    await ctx.assertCurrent(job);
    await this.products.queuePurgeForProduct(job.resourceKey, job.userId);

    const state = await this.products.purgeState(job.resourceKey, job.userId);
    // Строки нет — стирать нечего, идемпотентный подтверждённый успех.
    if (state === null) return;
    // Чужой продукт или ещё не подтверждённое host-стирание — fail-closed.
    if (!state.owned || !state.purgedAt) throw new DeletionRetryError('external_unknown');

    await ctx.assertCurrent(job);
    await this.products.removeBackupForProduct(job.resourceKey, job.userId);
    // Копия не на этой машине (или не стёрлась) — repo_url цел, удаления нет.
    if (state.repoUrl && !(await this.products.backupCleared(job.resourceKey, job.userId))) {
      throw new DeletionRetryError('external_unknown');
    }

    await ctx.assertCurrent(job);
    if (!(await this.products.deletePurgedProduct(job.resourceKey, job.userId, job.deletionId))) {
      throw new DeletionRetryError('external_unknown');
    }
  }
}
