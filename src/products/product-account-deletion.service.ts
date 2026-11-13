import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import {
  killActiveProvisionJobsCte,
  killActiveTurnsCte,
  queueForcedSleepCte,
} from './product-forced-stop';
import { ProductLifecycleService } from './product-lifecycle.service';
import { ProductPurgeService } from './product-purge.service';

export type ProductSleepStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * Факты продукта для шага product.purge: принадлежит ли владельцу, поставлен
 * ли штамп стирания агентом машины (completePurgeJob) и где резервная копия.
 */
export interface ProductPurgeState {
  owned: boolean;
  purgedAt: Date | null;
  repoUrl: string | null;
}

/**
 * Срок хранения архива продукта удалённого аккаунта до стирания — 30 дней
 * (требование плана удаления). Единственный источник для обоих SQL ниже и
 * для предиката archiveState; ACCOUNT_DELETION_RETENTION_MS координатора —
 * свой срок про другое и здесь не используется.
 */
export const PRODUCT_DELETION_PURGE_DAYS = 30;

interface ArchiveState {
  sleepStatus: ProductSleepStatus | null;
}

@Injectable()
export class ProductAccountDeletionService {
  private readonly logger = new Logger(ProductAccountDeletionService.name);
  /**
   * Продукты, у которых уже заметили отсутствие хоста. Разовый error на
   * процесс — приём warnedSleepCap из ProductLifecycleService: retry без
   * сигнала и так не молчит в координаторе, а лог иначе получал бы ту же
   * строку каждые 6 часов весь срок хранения. На поведение не влияет.
   */
  private readonly warnedNoHost = new Set<string>();

  constructor(
    private readonly pg: PgService,
    private readonly lifecycle: ProductLifecycleService,
    private readonly purge: ProductPurgeService,
  ) {}

  /** Scoped-стирание архива одного продукта (секреты, тексты, first_prompt). */
  async wipeExpiredForProduct(productId: string, userId: string): Promise<number> {
    return this.purge.wipeExpiredForProduct(productId, userId);
  }

  /** Scoped-постановка host pull-модели purge одному продукту владельца. */
  async queuePurgeForProduct(productId: string, userId: string): Promise<number> {
    return this.purge.queuePurgeForProduct(productId, userId);
  }

  /** Scoped-стирание резервной копии одного продукта (строго на этой машине). */
  async removeBackupForProduct(productId: string, userId: string): Promise<number> {
    return this.purge.removeBackupForProduct(productId, userId);
  }

  /**
   * Факты purge-шага по продукту: null — строки нет вовсе (идемпотентный
   * успех), owned=false — чужой продукт (fail-closed, не удаляем). purged_at
   * ставит только отчёт агента машины (completePurgeJob) — до него
   * relational-строки не трогаются.
   */
  async purgeState(productId: string, userId: string): Promise<ProductPurgeState | null> {
    const r = await this.pg.query(
      `SELECT p.user_id = $2 AS owned, p.purged_at, p.repo_url
         FROM products p
        WHERE p.id = $1`,
      [productId, userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      owned: row.owned === true,
      purgedAt: row.purged_at ?? null,
      repoUrl: row.repo_url ?? null,
    };
  }

  /**
   * Подтверждение, что резервная копия обнулена (repo_url IS NULL) у стёртого
   * продукта. Отсутствие строки — тоже подтверждение: удалять уже нечего.
   */
  async backupCleared(productId: string, userId: string): Promise<boolean> {
    const r = await this.pg.query(
      `SELECT p.repo_url IS NULL AS cleared
         FROM products p
        WHERE p.id = $1 AND p.user_id = $2 AND p.purged_at IS NOT NULL`,
      [productId, userId],
    );
    if (!r.rows[0]) return true;
    return r.rows[0].cleared === true;
  }

  /**
   * Финал purge-шага: relational-строки продукта удаляются ТОЛЬКО после того,
   * как агент машины подтвердил стирание (purged_at IS NOT NULL) и только
   * своему удалению текущего поколения (u.state='deleted' + deletion_id —
   * тот же страж, что у assertCurrent и archiveState). Один оператор в
   * транзакции: product_actions — ON DELETE SET NULL (журнал), поэтому
   * удаляется явно в CTE; turns/jobs/domains уходят каскадами.
   *
   * Повтор при уже удалённой строке — подтверждённый успех (true): повторный
   * attempt координатора не должен вечно держать job. Отказ стражей (чужой
   * продукт, не стёрт, старое поколение) — false, и adapter уходит в
   * fail-closed retry.
   */
  async deletePurgedProduct(
    productId: string,
    userId: string,
    deletionId: string,
  ): Promise<boolean> {
    const r = await this.pg.query(
      `WITH target AS (
          SELECT p.id
            FROM products p
            JOIN user_id u ON u.internal_id = p.user_id
           WHERE p.id = $1 AND p.user_id = $2
             AND u.state = 'deleted' AND u.deletion_id = $3
             AND p.purged_at IS NOT NULL
             FOR UPDATE OF p
       ), actions AS (
          DELETE FROM product_actions a USING target t
           WHERE a.product_id = t.id RETURNING a.id
       ), deleted AS (
          DELETE FROM products p USING target t
           WHERE p.id = t.id RETURNING p.id
       )
       -- Обе ссылки держат data-modifying CTE частью плана этого оператора —
       -- тот же приём, что в forceStop (см. комментарий там про форму запроса).
       SELECT (SELECT id FROM deleted) AS id,(SELECT count(*) FROM actions) AS removed_actions`,
      [productId, userId, deletionId],
    );
    if (r.rows[0]?.id) return true;
    const exists = await this.pg.query(
      `SELECT 1 FROM products WHERE id = $1`,
      [productId],
    );
    return exists.rows.length === 0;
  }

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
          AND p.purge_after=u.deleted_at+make_interval(days => $4)
          AND p.first_prompt IS NULL AND p.first_prompt_channel IS NULL`,
      [productId, userId, deletionId, PRODUCT_DELETION_PURGE_DAYS],
    );
    if (!result.rows[0]) return null;
    return { sleepStatus: result.rows[0].sleep_status ?? null };
  }

  /**
   * Гонка с purge: штатное почасовое стирание продуктов могло опередить этот
   * job (products.purged_at выставлен), а строка продукта могла исчезнуть
   * вовсе. purged — более сильная остановка, чем sleep: контейнера и данных
   * уже нет. Отсутствие строки — останавливать нечего. Оба исхода —
   * ПОДТВЕРЖДЁННЫЙ успех, а не fail-closed retry: вечный retry одного
   * product.stop блокировал бы всё удаление аккаунта (тот же resourceKey
   * ждёт product.purge). Чужой продукт (user_id не совпал) сюда не попадает
   * и остаётся fail-closed.
   */
  private async purgedOrMissing(productId: string, userId: string): Promise<boolean> {
    const result = await this.pg.query(
      `SELECT (p.purged_at IS NOT NULL AND p.user_id=$2) AS stopped
         FROM products p
        WHERE p.id=$1`,
      [productId, userId],
    );
    if (!result.rows[0]) return true;
    return result.rows[0].stopped === true;
  }

  /**
   * claimJob выдаёт sleep строго по p.host_id: у продукта с host_id NULL
   * queued-sleep не заберёт НИКТО, и retry координатора идут каждые 6 часов
   * БЕЗ error-сигнала — счётчик провалов в queueSleepForDeleted считает
   * только failed, а здесь сон не проваливается, он вечно queued. Разовый
   * error — след для ручного разбора; в тексте только uuid продукта, без
   * userId и иного PII. Retry-поведение сохраняется: координатор не должен
   * забыть job.
   */
  private async warnIfSleepHasNoHost(productId: string): Promise<void> {
    if (this.warnedNoHost.has(productId)) return;
    const result = await this.pg.query(`SELECT host_id FROM products WHERE id=$1`, [productId]);
    if (result.rows[0] && result.rows[0].host_id == null) {
      this.warnedNoHost.add(productId);
      this.logger.error(
        `product sleep has no host to claim — manual review needed (product ${productId})`,
      );
    }
  }

  /**
   * Немедленно закрывает локальную работу и оставляет host pull-модели sleep.
   * Повтор при уже существующем sleep ничего не переставляет: queued/running/
   * failed остаются retry, done — единственный подтверждённый идемпотентный
   * успех. purged/отсутствие строки — тоже подтверждённый успех (см.
   * purgedOrMissing), а sleep без хоста сопровождается разовым error (см.
   * warnIfSleepHasNoHost).
   */
  async stop(
    productId: string,
    userId: string,
    deletionId: string,
  ): Promise<ProductSleepStatus | null> {
    if (await this.purgedOrMissing(productId, userId)) return 'done';
    const status = await this.forceStop(productId, userId, deletionId);
    if (status !== null && status !== 'done') await this.warnIfSleepHasNoHost(productId);
    return status;
  }

  private async forceStop(
    productId: string,
    userId: string,
    deletionId: string,
  ): Promise<ProductSleepStatus | null> {
    const existing = await this.archiveState(productId, userId, deletionId);
    if (existing?.sleepStatus) return existing.sleepStatus;

    const stopped = await this.pg.query(
      `WITH target AS (
          SELECT p.id,u.deleted_at+make_interval(days => $4) AS purge_after
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
       ), ${queueForcedSleepCte({ onConflictDoNothing: true, skipWhenSleepConfirmed: true })}
       -- Столбец queued кодом НЕ читается и оставлен намеренно: ссылка в
       -- финальном SELECT держит data-modifying CTE частью плана этого
       -- оператора (PostgreSQL и так исполняет их до конца, но форма запроса
       -- без ссылки уже измерялась как источник гонок — см. докблок
       -- queueForcedSleepCte). Убирать столбец — правка формы без выигрыша.
       SELECT (SELECT id FROM target) AS id,(SELECT count(*) FROM queued) AS queued`,
      [productId, userId, deletionId, PRODUCT_DELETION_PURGE_DAYS],
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
