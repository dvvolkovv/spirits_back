import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { inTransaction } from '../blog/blog-slot-claim';
import { PgService } from '../common/services/pg.service';
import { AccountDeletionJobs } from './account-deletion.jobs';
import { AccountDeletionPlanner } from './account-deletion.planner';
import { AccountDeletionRegistry } from './account-deletion.registry';
import { AccountDeletionRunner } from './account-deletion.runner';
import {
  DeletionRetryError,
  deletionErrorKind,
  safeDeletionMessage,
} from './account-deletion.safe';
import type {
  DeletionAccount,
  DeletionDiscovery,
  DeletionOrigin,
} from './account-deletion.types';

type Db = DeletionDiscovery['db'];

/**
 * Фиксированное безопасное сообщение 503 для явного удаления. HTTP-ответ не
 * должен раскрывать deletionId, userId или состав задач: клиенту сообщается
 * только факт временной недоступности и возможность повторить. Детали уходят
 * в лог через safeDeletionMessage (валидированный fail-closed снапшот).
 */
export const EXPLICIT_DELETION_UNAVAILABLE =
  'Account deletion is temporarily unavailable. Please try again later.';

/**
 * Task 18 — координатор явного удаления аккаунта (HTTP DELETE /webhook/profile).
 *
 * Порядок, зафиксированный планом:
 *   1. registry.assertReady()      — деплой без адаптеров не должен молча
 *                                    «удалять» аккаунты (ошибка всплывает как есть);
 *   2. begin(userId, origin)       — одна транзакция: FOR UPDATE, решение о
 *                                    поколении, collect+persist плана;
 *   3. runner.runImmediateStops()  — ПОСЛЕ commit: внешние остановки
 *                                    (рассылки, боты, продукты, календарь, голос)
 *                                    синхронно, в одном HTTP-запросе;
 *   4. jobs.find(core) + runJob    — core finalize (allStop уже удовлетворён
 *                                    шагом 3 + контрольным assertNoImmediateBlockers);
 *   5. контрольное find(core)      — runJob глотает ошибки адаптеров, поэтому
 *                                    успех измеряется статусом строки, а не
 *                                    отсутствием исключения.
 *
 * Любая неудача шагов 3–5 — ServiceUnavailableException(503) с фиксированным
 * сообщением: аккаунт остаётся в удалённом поколении с незавершёнными задачами,
 * повторный DELETE (или почасовой воркер) продолжает с того же места. Ложный
 * success невозможен.
 *
 * Cron/worker здесь НЕ задействован: явный путь исполняет immediate-задачи
 * синхронно (ловушка плана), а purge-фаза остаётся за воркером.
 */
@Injectable()
export class AccountDeletionLifecycle {
  private readonly logger = new Logger(AccountDeletionLifecycle.name);

  constructor(
    private readonly pg: PgService,
    private readonly planner: AccountDeletionPlanner,
    private readonly jobs: AccountDeletionJobs,
    private readonly registry: AccountDeletionRegistry,
    private readonly runner: AccountDeletionRunner,
  ) {}

  async deleteExplicit(userId: string): Promise<void> {
    // Вне try: неготовый реестр — ошибка деплоя (deletion_registry_not_ready),
    // она обязана всплыть как есть, а не маскироваться под «временно недоступно».
    await this.registry.assertReady();

    const account = await this.begin(userId, 'explicit');
    // historical deleted без generation не включается (см. begin): возвращаемся
    // молча — для клиента это идемпотентный успех, данных поколения нет.
    if (!account) return;

    try {
      await this.runner.runImmediateStops(account.deletionId);
      const core = await this.jobs.find(
        account.deletionId,
        'account.core.immediate',
        'account',
      );
      await this.runner.runJob(core);
      // Обнаружение неуспешного stop/core: runJob глотает ошибку адаптера
      // (jobs.fail + safe warn), поэтому повторно читаем строку задачи.
      // done — успех (в т.ч. если core досрочно доделал конкурент);
      // pending/failed/running/cancelled — retryable-исход, не success.
      const finished = await this.jobs.find(
        account.deletionId,
        'account.core.immediate',
        'account',
      );
      if (finished.status !== 'done') throw new DeletionRetryError('db');
    } catch (error) {
      this.logger.warn(safeDeletionMessage({
        deletionId: account.deletionId,
        resourceType: 'account.core.immediate',
        resourceKey: 'account',
        attempts: 0,
        kind: deletionErrorKind(error),
        userId,
      }));
      throw new ServiceUnavailableException(EXPLICIT_DELETION_UNAVAILABLE);
    }
  }

  /**
   * Вход в удаление: ОДНА транзакция — блокировка строки, решение о поколении
   * и планирование с персистенцией плана.
   *
   * Ветки по state:
   *  - active: новое поколение — state='deleted', deleted_at=now(),
   *    deletion_id=gen_random_uuid() через UPDATE ... RETURNING. После
   *    reactivation (которая не очищает deletion_id/deleted_at) новое удаление
   *    всегда получает новый UUID: старые задачи fencing не пропустит.
   *  - deleted + deletion_id: переиспользование ТЕКУЩЕГО поколения — явный
   *    retry упавшего запроса; план допланируется в той же tx через
   *    ON CONFLICT DO NOTHING (задачи не дублируются).
   *  - deleted без deletion_id: historical-удаление (до введения pipeline) —
   *    null, удаление не включается.
   *  - прочие state (NULL, 'blocked', ...): null — pipeline работает только с
   *    active→deleted. Судьба заблокированных модерацией аккаунтов — отдельное
   *    решение (FU-T11-2), здесь они сознательно не трогаются.
   *
   * План читается и персистится ВНУТРИ той же транзакции, до commit:
   *  - collect видит refs (историю, идентичности) до их стирания — ядро ещё
   *    не запускалось;
   *  - I3-T11: поздний chat-file.purge рождается вместе с поколением и точно
   *    раньше удаления истории, а не надеется на recapture внутри core;
   *  - неудача планирования откатывает и само поколение — «удалён наполовину»
   *    не возникает.
   * Внешние stop'ы исполняются ПОСЛЕ commit (deleteExplicit), не под блокировкой.
   *
   * origin — параметр с самого начала: Task 19 (merge) вызовет
   * begin(loserUserId, 'merge') с plan-веткой account.core.purge.
   */
  async begin(userId: string, origin: DeletionOrigin): Promise<DeletionAccount | null> {
    return inTransaction(this.pg, async (tx) => {
      const locked = await tx.query(
        `SELECT state, deletion_id, deleted_at
         FROM user_id
         WHERE internal_id = $1
         FOR UPDATE`,
        [userId],
      );
      const row = locked.rows?.[0];
      if (!row) return null;

      const account = await this.resolveGeneration(tx, userId, row);
      if (!account) return null;

      const plan = await this.planner.collect(tx as Db, account, origin);
      await this.planner.persist(tx as Db, account, plan);
      return account;
    });
  }

  /** Выбор поколения под уже взятой блокировкой строки (см. begin). */
  private async resolveGeneration(
    tx: Db,
    userId: string,
    row: { state: string | null; deletion_id: string | null; deleted_at: Date | string | null },
  ): Promise<DeletionAccount | null> {
    if (row.state === 'deleted') {
      if (row.deletion_id && row.deleted_at) {
        return {
          userId,
          deletionId: row.deletion_id,
          deletedAt: new Date(row.deleted_at),
        };
      }
      // Historical-удаление без поколения: включать pipeline нечего.
      return null;
    }
    if (row.state !== 'active') {
      // NULL/'blocked'/прочее — FU-T11-2: не наша ветка (см. begin).
      return null;
    }
    const updated = await tx.query(
      `UPDATE user_id
       SET state = 'deleted', deleted_at = now(), deletion_id = gen_random_uuid(), update_date = now()
       WHERE internal_id = $1 AND state = 'active'
       RETURNING internal_id, deletion_id, deleted_at`,
      [userId],
    );
    const fresh = updated.rows?.[0];
    // Оборона: под FOR UPDATE строка active не может исчезнуть; если всё же
    // 0 строк — поколение не создано, удаление не начинаем.
    if (!fresh) return null;
    return {
      userId: fresh.internal_id,
      deletionId: fresh.deletion_id,
      deletedAt: new Date(fresh.deleted_at),
    };
  }
}
