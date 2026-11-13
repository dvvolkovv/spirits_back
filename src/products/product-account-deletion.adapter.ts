import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DeletionRetryError } from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscoverer,
  DeletionExecution,
  DeletionJobRow,
  DeletionJobSpec,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { ProductAccountDeletionService } from './product-account-deletion.service';

/**
 * Read-only discovery одного поколения. product.stop — только нестёртым
 * продуктам; product.purge — ВСЕМ продуктам поколения, включая уже стёртые
 * штатным обходом до удаления аккаунта (purged_at IS NOT NULL): их строки и
 * журнал тоже должны быть удалены. Planner относит runAt purge-задач на
 * deletedAt + срок хранения, а зависимость sameResourceKey product.stop
 * (DELETION_DEPENDENCIES) не даёт purge стартовать раньше остановки; у
 * стёртых продуктов stop-строки нет, и NOT EXISTS-зависимость claimNext
 * считается удовлетворённой — purge выдаётся сразу по сроку.
 */
export const discoverProductDeletion: DeletionDiscoverer = async ({ db, account }) => {
  const products = await db.query(
    `SELECT p.id,p.slug,p.host_id,p.purged_at
       FROM products p
       JOIN user_id u ON u.internal_id=p.user_id
      WHERE p.user_id=$1
        AND u.state='deleted' AND u.deletion_id=$2
      ORDER BY p.id`,
    [account.userId, account.deletionId],
  );
  const jobs: DeletionJobSpec[] = [];
  for (const row of products.rows) {
    const productId = String(row.id);
    // slug в схеме NOT NULL; host_id может быть NULL — sanitizer пропускает
    // null-значения, payload обоих job'ов технический (id/slug/host).
    const payload = {
      productId,
      slug: String(row.slug),
      hostId: row.host_id == null ? null : String(row.host_id),
    };
    if (row.purged_at == null) {
      jobs.push({
        resourceType: 'product.stop' as const,
        resourceKey: productId,
        phase: 'immediate' as const,
        payload: { ...payload },
      });
    }
    jobs.push({
      resourceType: 'product.purge' as const,
      resourceKey: productId,
      phase: 'purge' as const,
      payload: { ...payload },
    });
  }
  return { jobs, skips: [] };
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
