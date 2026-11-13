import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import {
  killActiveProvisionJobsCte,
  killActiveTurnsCte,
  queueForcedSleepCte,
} from './product-forced-stop';
import { ProductLifecycleService } from './product-lifecycle.service';

export type ProductSleepStatus = 'queued' | 'running' | 'done' | 'failed';

interface ArchiveState {
  sleepStatus: ProductSleepStatus | null;
}

@Injectable()
export class ProductAccountDeletionService {
  constructor(
    private readonly pg: PgService,
    private readonly lifecycle: ProductLifecycleService,
  ) {}

  /**
   * Читает только архив текущего deletion generation с полностью выставленным
   * сроком. LATERAL возвращает также отсутствие sleep — это repair-состояние,
   * а не успех.
   */
  private async archiveState(
    productId: string,
    userId: string,
    deletionId: string,
  ): Promise<ArchiveState | null> {
    const result = await this.pg.query(
      `SELECT sleep.status AS sleep_status
         FROM products p
         JOIN user_id u ON u.internal_id=p.user_id
         LEFT JOIN LATERAL (
           SELECT j.status FROM product_provision_jobs j
            WHERE j.product_id=p.id AND j.kind='sleep'
              AND j.created_at>=p.archived_at
            ORDER BY j.created_at DESC,j.id DESC LIMIT 1
         ) sleep ON TRUE
        WHERE p.id=$1 AND p.user_id=$2
          AND u.state='deleted' AND u.deletion_id=$3 AND u.deleted_at IS NOT NULL
          AND p.status='archived' AND p.archived_at IS NOT NULL AND p.purged_at IS NULL
          AND p.purge_after=u.deleted_at+interval '30 days'
          AND p.first_prompt IS NULL AND p.first_prompt_channel IS NULL`,
      [productId, userId, deletionId],
    );
    if (!result.rows[0]) return null;
    return { sleepStatus: result.rows[0].sleep_status ?? null };
  }

  /**
   * Немедленно закрывает локальную работу и оставляет host pull-модели sleep.
   * Повтор при уже существующем sleep ничего не переставляет: queued/running/
   * failed остаются retry, done — единственный подтверждённый идемпотентный успех.
   */
  async stop(
    productId: string,
    userId: string,
    deletionId: string,
  ): Promise<ProductSleepStatus | null> {
    const existing = await this.archiveState(productId, userId, deletionId);
    if (existing?.sleepStatus) return existing.sleepStatus;

    const stopped = await this.pg.query(
      `WITH target AS (
          SELECT p.id,u.deleted_at+interval '30 days' AS purge_after
            FROM products p
            JOIN user_id u ON u.internal_id=p.user_id
           WHERE p.id=$1 AND p.user_id=$2
             AND u.state='deleted' AND u.deletion_id=$3 AND u.deleted_at IS NOT NULL
             AND p.purged_at IS NULL
             FOR UPDATE OF p
       ), ${killActiveProvisionJobsCte("'account_deleted'")},
          ${killActiveTurnsCte("'account_deleted'")}, marked AS (
          UPDATE products p
             SET status='archived',archived_at=COALESCE(archived_at,now()),
                 purge_after=t.purge_after,first_prompt=NULL,first_prompt_channel=NULL
            FROM target t
           WHERE p.id=t.id
          RETURNING p.id
       ), ${queueForcedSleepCte({ onConflictDoNothing: true })}
       SELECT (SELECT id FROM target) AS id,(SELECT count(*) FROM queued) AS queued`,
      [productId, userId, deletionId],
    );
    // Старый generation или чужой продукт не дают target. Repair в этом случае
    // запрещён: queueSleepForDeleted сам по себе deletion generation не знает.
    if (!stopped.rows[0]?.id) return null;

    let current = await this.archiveState(productId, userId, deletionId);
    if (!current) return null;
    if (current.sleepStatus) return current.sleepStatus;

    // ON CONFLICT DO NOTHING не является подтверждением sleep. Сначала читаем
    // факт, затем используем существующий repair и обязательно читаем снова.
    await this.lifecycle.queueSleepForDeleted(productId);
    current = await this.archiveState(productId, userId, deletionId);
    return current?.sleepStatus ?? null;
  }
}
