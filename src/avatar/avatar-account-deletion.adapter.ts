import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionErrorKind,
  deletionResourceHash,
} from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscovery,
  DeletionExecution,
  DeletionJobRow,
  DeletionPlan,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { AvatarService } from './avatar.service';

/**
 * Task 13 — пользовательские аватары при удалении аккаунта.
 *
 * Job пустой (payload {}): цели НЕ хранятся в плане, а вычисляются в execute
 * из job.userId (колонка job, не payload) — только канонические ключи
 * avatars/users/<userId>.{jpg,png,webp,gif} в linkeon-assets и легаси-файл
 * public/avatars/<userId>.jpg. УРОК Task 11: произвольные строки (пути/URL) в
 * payload не кладутся.
 *
 * profile_data.avatar_url НЕ используется как произвольная цель удаления:
 * в нём может лежать чужой или агентский ключ. avatars/agents/ не выбирается
 * никогда — агентские аватары общие и удалению аккаунта не принадлежат.
 */

export async function discoverAvatarDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: avatar.purge планируется,
  // лишь пока строка удалённого поколения на месте. Отдельной таблицы
  // аватаров нет (profile_data.avatar_url не читается — см. шапку).
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [{
      resourceType: 'avatar.purge',
      // resourceKey не должен содержать userId — детерминированный хэш.
      resourceKey: deletionResourceHash('avatar', account.userId),
      phase: 'purge',
      payload: {},
    }],
    skips: [],
  };
}

@Injectable()
export class AvatarAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['avatar.purge'];

  constructor(
    private readonly avatar: AvatarService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'avatar.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    try {
      await this.avatar.deleteAvatarForDeletion(job.userId, job.deletionId);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
    // Внешние операции (MinIO/fs) могли занять время: перед тем как считать
    // job выполненным, поколение и lease перепроверяются.
    await ctx.assertCurrent(job);
  }
}
