import { Injectable, OnModuleInit } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import type {
  AccountDeletionAdapter,
  DeletionDiscoverer,
  DeletionJobRow,
  DeletionExecution,
  DeletionJobSpec,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { RoutinePushService } from './routine-push.service';

/**
 * Read-only discovery: только технические ID. Тексты рутин и push endpoint
 * не должны попадать ни в persistent job payload, ни в журналы deletion runner.
 */
export const discoverRoutinePushDeletion: DeletionDiscoverer = async ({ db, account }) => {
  const routines = await db.query(
    `SELECT r.id FROM routine_pushes r WHERE r.user_id=$1 ORDER BY r.id`,
    [account.userId],
  );
  const subscriptions = await db.query(
    `SELECT 1 FROM push_subscriptions s WHERE s.user_id=$1 LIMIT 1`,
    [account.userId],
  );
  const jobs: DeletionJobSpec[] = routines.rows.flatMap((row) => {
    const routineId = String(row.id);
    return [
      {
        resourceType: 'routine.stop' as const,
        resourceKey: routineId,
        phase: 'immediate' as const,
        payload: { routineId },
      },
      {
        resourceType: 'routine.purge' as const,
        resourceKey: routineId,
        phase: 'purge' as const,
        payload: { routineId },
      },
    ];
  });
  if (subscriptions.rows.length > 0) {
    jobs.push({
      resourceType: 'push.purge',
      resourceKey: 'push',
      phase: 'purge',
      payload: {},
    });
  }
  return { jobs, skips: [] };
};

@Injectable()
export class RoutineAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = [
    'routine.stop',
    'routine.purge',
    'push.purge',
  ];

  constructor(
    private readonly pg: PgService,
    private readonly routines: RoutinePushService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    switch (job.resourceType) {
      case 'routine.stop': {
        const result = await this.pg.query(
          `UPDATE routine_pushes r SET enabled=false
           WHERE r.id=$1 AND r.user_id=$2
             AND EXISTS (
               SELECT 1 FROM user_id u
               WHERE u.internal_id=$2 AND u.state='deleted' AND u.deletion_id=$3
             )`,
          [job.resourceKey, job.userId, job.deletionId],
        );
        // Старый deletion generation после reactivation не должен гасить новые timers.
        if (result.rowCount === 1) this.routines.clearRetryTimersForUser(job.userId);
        return;
      }
      case 'routine.purge':
        await ctx.assertCurrent(job);
        await this.pg.query(
          `DELETE FROM routine_pushes r
           WHERE r.id=$1 AND r.user_id=$2
             AND EXISTS (
               SELECT 1 FROM user_id u
               WHERE u.internal_id=$2 AND u.state='deleted' AND u.deletion_id=$3
             )`,
          [job.resourceKey, job.userId, job.deletionId],
        );
        return;
      case 'push.purge':
        await ctx.assertCurrent(job);
        await this.pg.query(
          `DELETE FROM push_subscriptions s
           WHERE s.user_id=$1
             AND EXISTS (
               SELECT 1 FROM user_id u
               WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2
             )`,
          [job.userId, job.deletionId],
        );
        return;
      default:
        throw new Error('unsupported_deletion_resource');
    }
  }
}
