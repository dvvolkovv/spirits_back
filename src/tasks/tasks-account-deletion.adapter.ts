import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionErrorKind,
} from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscovery,
  DeletionExecution,
  DeletionJobRow,
  DeletionPlan,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';

/**
 * Task 17A — tasks: немедленная остановка и delayed purge.
 *
 * tasks.stop (immediate) архивирует активные задачи поколения: 'archived' —
 * статус из CHECK схемы (001_tasks.sql), после него задачи не всплывают в
 * context injection (buildContextForPrompt берёт active поверх archived, но
 * stop снимает задачи с «активного» списка сразу). tasks.purge (после
 * retention) удаляет строки tasks целиком под generation predicate;
 * task_events исчезает существующим FK ON DELETE CASCADE (001_tasks.sql:32) —
 * отдельного SQL для событий нет.
 *
 * Job'ы пустые (payload {}, статические resourceKey 'tasks' без userId —
 * урок Task 11: произвольные строки в payload не кладутся; цель целиком
 * выводится из job.userId). Внешних вызовов (LLM/Telegram) в stop/purge нет —
 * только SQL, поэтому достаточно одного assertCurrent до записи, а TOCTOU
 * закрывает generation predicate внутри UPDATE/DELETE (паттерн events).
 * Повторный прогон идемпотентен: 0 строк — тихий успех.
 *
 * Порядок stop → purge обеспечивает правило DELETION_DEPENDENCIES
 * ('tasks.purge': { allOf: ['tasks.stop'] }) через DEPENDENCY_ELIGIBILITY_SQL
 * в claimNext.
 */

const TASKS_STOP_SQL = `UPDATE tasks SET status='archived', updated_at=now()
 WHERE user_id=$1 AND status='active'
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

const TASKS_PURGE_SQL = `DELETE FROM tasks
 WHERE user_id=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

export async function discoverTasksDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: задачи при планировании не
  // читаются (title/summary/claudemd в план не поднимаются).
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [
      {
        resourceType: 'tasks.stop',
        // Статический ключ (по одному job на аккаунт), без userId, по RESOURCE_KEY_RE.
        resourceKey: 'tasks',
        phase: 'immediate',
        payload: {},
      },
      {
        resourceType: 'tasks.purge',
        resourceKey: 'tasks',
        phase: 'purge',
        payload: {},
      },
    ],
    skips: [],
  };
}

@Injectable()
export class TasksAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['tasks.stop', 'tasks.purge'];

  constructor(private readonly registry: AccountDeletionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'tasks.stop' && job.resourceType !== 'tasks.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    try {
      await ctx.db.query(
        job.resourceType === 'tasks.stop' ? TASKS_STOP_SQL : TASKS_PURGE_SQL,
        [job.userId, job.deletionId],
      );
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
