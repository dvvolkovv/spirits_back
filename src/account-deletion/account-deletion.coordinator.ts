import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { AccountDeletionJobs } from './account-deletion.jobs';
import { AccountDeletionPlanner } from './account-deletion.planner';
import { AccountDeletionRunner } from './account-deletion.runner';
import {
  ACCOUNT_DELETION_RETENTION_MS,
  accountDeletionWorkerEnabled,
} from './account-deletion.safe';

export interface AccountDeletionTickOptions {
  retentionMs?: number;
  batchSize?: number;
}

@Injectable()
export class AccountDeletionCoordinator {
  constructor(
    private readonly pg: PgService,
    private readonly planner: AccountDeletionPlanner,
    private readonly jobs: AccountDeletionJobs,
    private readonly runner: AccountDeletionRunner,
  ) {}

  @Cron('0 23 * * * *', { name: 'account-deletion-coordinator' })
  async tick(options: AccountDeletionTickOptions = {}): Promise<void> {
    if (!accountDeletionWorkerEnabled(process.env)) return;
    const lock = await this.pg.tryAdvisoryLock(1947433922);
    if (!lock) return;

    try {
      let after: [Date, string] | null = null;
      do {
        const accounts = await this.jobs.dueAccounts(
          after,
          options.batchSize ?? 50,
          options.retentionMs ?? ACCOUNT_DELETION_RETENTION_MS,
        );
        for (const account of accounts) {
          const origin = await this.jobs.originOf(account);
          const plan = await this.planner.collect(this.pg, account, origin);
          await this.planner.persist(this.pg, account, plan);
          await this.runner.runAccount(account.deletionId);
        }
        after = accounts.length
          ? [accounts[accounts.length - 1].deletedAt, accounts[accounts.length - 1].userId]
          : null;
      } while (after);
    } finally {
      await lock.release();
    }
  }
}
