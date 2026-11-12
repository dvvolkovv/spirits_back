import {
  ACCOUNT_DELETION_RETENTION_MS,
  assertSafeJobSpec,
} from './account-deletion.safe';
import type {
  DeletionAccount,
  DeletionDiscoverer,
  DeletionDiscovery,
  DeletionJobSpec,
  DeletionOrigin,
  DeletionPlan,
  DeletionSkip,
} from './account-deletion.types';

type Db = DeletionDiscovery['db'];

export class AccountDeletionPlanner {
  constructor(private readonly discoverers: readonly DeletionDiscoverer[]) {}

  async collect(
    db: Db,
    account: DeletionAccount,
    origin: DeletionOrigin,
  ): Promise<DeletionPlan> {
    const jobs: DeletionJobSpec[] = [{
      resourceType: origin === 'explicit'
        ? 'account.core.immediate'
        : 'account.core.purge',
      resourceKey: 'account',
      phase: origin === 'explicit' ? 'immediate' : 'purge',
      payload: {},
    }];
    const skips: DeletionSkip[] = [];

    for (const discover of this.discoverers) {
      const part = await discover({ db, account, origin });
      for (const job of part.jobs) {
        assertSafeJobSpec(job, account.userId);
        jobs.push(job);
      }
      skips.push(...part.skips);
    }

    return { jobs, skips };
  }

  async persist(
    db: Db,
    account: DeletionAccount,
    plan: DeletionPlan,
  ): Promise<void> {
    for (const job of plan.jobs) {
      const runAt = job.phase === 'immediate'
        ? new Date()
        : new Date(account.deletedAt.getTime() + ACCOUNT_DELETION_RETENTION_MS);
      await db.query(
        `INSERT INTO account_deletion_jobs
          (deletion_id,user_id,resource_type,resource_key,phase,payload_jsonb,next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT (deletion_id,resource_type,resource_key) DO NOTHING`,
        [
          account.deletionId,
          account.userId,
          job.resourceType,
          job.resourceKey,
          job.phase,
          JSON.stringify(job.payload),
          runAt,
        ],
      );
    }
  }
}
