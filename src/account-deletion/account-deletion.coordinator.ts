import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { AccountDeletionJobs } from './account-deletion.jobs';
import { AccountDeletionPlanner } from './account-deletion.planner';
import { AccountDeletionRunner, emptyDeletionRunSummary } from './account-deletion.runner';
import {
  ACCOUNT_DELETION_RETENTION_MS,
  DeletionTickTotals,
  accountDeletionWorkerEnabled,
  accountDeletionWorkerFlagUnrecognized,
  accountDeletionWorkerSkippedTickMessage,
  accountDeletionWorkerStateMessage,
  deletionErrorKind,
  safeDeletionMessage,
  safeDeletionTickMessage,
} from './account-deletion.safe';

export interface AccountDeletionTickOptions {
  retentionMs?: number;
  batchSize?: number;
}

@Injectable()
export class AccountDeletionCoordinator implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccountDeletionCoordinator.name);

  constructor(
    private readonly pg: PgService,
    private readonly planner: AccountDeletionPlanner,
    private readonly jobs: AccountDeletionJobs,
    private readonly runner: AccountDeletionRunner,
  ) {}

  /**
   * Одна строка при старте процесса: включена ли очистка и значение env;
   * нераспознанное значение (считается выключением) — в warn.
   */
  onApplicationBootstrap(): void {
    const message = accountDeletionWorkerStateMessage(process.env);
    if (accountDeletionWorkerFlagUnrecognized(process.env)) this.logger.warn(message);
    else this.logger.log(message);
  }

  @Cron('0 23 * * * *', { name: 'account-deletion-coordinator' })
  async tick(options: AccountDeletionTickOptions = {}): Promise<void> {
    if (!accountDeletionWorkerEnabled(process.env)) {
      if (accountDeletionWorkerFlagUnrecognized(process.env)) {
        this.logger.warn(accountDeletionWorkerSkippedTickMessage(process.env));
      }
      return;
    }
    const lock = await this.pg.tryAdvisoryLock(1947433922);
    if (!lock) return;

    const startedAt = Date.now();
    const totals: DeletionTickTotals = { accounts: 0, errors: 0, ...emptyDeletionRunSummary() };
    try {
      let after: [string, string] | null = null;
      do {
        const accounts = await this.jobs.dueAccounts(
          after,
          options.batchSize ?? 50,
          options.retentionMs ?? ACCOUNT_DELETION_RETENTION_MS,
        );
        for (const account of accounts) {
          totals.accounts += 1;
          try {
            const origin = await this.jobs.originOf(account);
            const plan = await this.planner.collect(this.pg, account, origin);
            await this.planner.persist(this.pg, account, plan);
            await this.runner.runAccount(account.deletionId, totals);
          } catch (error) {
            totals.errors += 1;
            const kind = deletionErrorKind(error);
            this.logger.warn(safeDeletionMessage({
              deletionId: account.deletionId,
              resourceType: 'account.core.purge',
              resourceKey: 'account',
              attempts: 0,
              kind,
              userId: account.userId,
            }));
          }
        }
        after = accounts.length
          ? [
            accounts[accounts.length - 1].deletedAtCursor,
            accounts[accounts.length - 1].userId,
          ]
          : null;
      } while (after);
    } finally {
      // Снятие lock не зависит от журнала: бросивший logger иначе оставил бы
      // advisory lock на соединении, и тики молча пропускались бы до рестарта.
      try {
        this.logger.log(safeDeletionTickMessage({ ...totals, durationMs: Date.now() - startedAt }));
      } finally {
        await lock.release();
      }
    }
  }
}
