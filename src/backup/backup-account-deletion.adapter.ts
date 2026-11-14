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
 * Task 17D — profile_backups: слепая зашифрованная копия профиля (A6 §4.2.1).
 *
 * Одна строка на пользователя (user_id TEXT PK; blob + prev_blob — текущая и
 * предыдущая копия). Purge удаляет её по user_id под generation predicate;
 * шифротекст при планировании не читается и в план не поднимается.
 *
 * Job пустой (payload {}, статический resourceKey 'backup' — урок Task 11:
 * цель целиком выводится из job.userId, колонки job, а не payload). Внешних
 * вызовов нет — только SQL: один assertCurrent до записи, TOCTOU закрывает
 * generation predicate внутри DELETE, повторный прогон идемпотентен (0 строк —
 * тихий успех, паттерн tasks/contacts).
 */

const PROFILE_BACKUP_PURGE_SQL = `DELETE FROM profile_backups
 WHERE user_id=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

export async function discoverBackupDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: profile_backups при
  // планировании не читается (blob в план не поднимается).
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [{
      resourceType: 'profile-backup.purge',
      // Статический ключ (один job на аккаунт), без userId, по RESOURCE_KEY_RE.
      resourceKey: 'backup',
      phase: 'purge',
      payload: {},
    }],
    skips: [],
  };
}

@Injectable()
export class BackupAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['profile-backup.purge'];

  constructor(private readonly registry: AccountDeletionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'profile-backup.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    try {
      await ctx.db.query(PROFILE_BACKUP_PURGE_SQL, [job.userId, job.deletionId]);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
