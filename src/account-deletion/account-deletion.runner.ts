import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { AccountDeletionJobs } from './account-deletion.jobs';
import { AccountDeletionRegistry } from './account-deletion.registry';
import {
  DeletionCancelledError,
  deletionErrorKind,
  safeDeletionMessage,
} from './account-deletion.safe';
import type { DeletionJobRow } from './account-deletion.types';

const HEARTBEAT_INTERVAL_MS = 30_000;

@Injectable()
export class AccountDeletionRunner {
  private readonly logger = new Logger(AccountDeletionRunner.name);

  constructor(
    private readonly pg: PgService,
    private readonly jobs: AccountDeletionJobs,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  async runAccount(deletionId: string): Promise<void> {
    while (true) {
      const job = await this.jobs.claimNext(deletionId);
      if (!job) return;
      await this.runJob(job);
    }
  }

  private async runJob(job: DeletionJobRow): Promise<void> {
    let heartbeatBusy = false;
    let heartbeatLost = false;
    let heartbeatError: { value: unknown } | null = null;
    let heartbeat = Promise.resolve();
    const timer = setInterval(() => {
      if (heartbeatBusy || heartbeatLost || heartbeatError) return;
      heartbeatBusy = true;
      heartbeat = (async () => {
        try {
          if (!await this.jobs.heartbeat(job)) heartbeatLost = true;
        } catch (error) {
          heartbeatError = { value: error };
        } finally {
          heartbeatBusy = false;
        }
      })();
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref();

    let adapterError: { value: unknown } | null = null;
    try {
      const executor = this.registry.getExecutor(job.resourceType);
      await executor.execute(job, {
        db: this.pg,
        assertCurrent: (current) => this.jobs.assertCurrent(current),
      });
    } catch (error) {
      adapterError = { value: error };
    } finally {
      clearInterval(timer);
      await heartbeat;
    }

    if (!adapterError && heartbeatError) {
      adapterError = heartbeatError;
    } else if (!adapterError && heartbeatLost) {
      adapterError = { value: new DeletionCancelledError() };
    }
    if (adapterError) {
      const kind = deletionErrorKind(adapterError.value);
      await this.jobs.fail(job, kind);
      this.logger.warn(safeDeletionMessage({
        deletionId: job.deletionId,
        resourceType: job.resourceType,
        resourceKey: job.resourceKey,
        attempts: job.attempts,
        kind,
        userId: job.userId,
      }));
      return;
    }

    if (!await this.jobs.finish(job)) {
      this.logger.warn(safeDeletionMessage({
        deletionId: job.deletionId,
        resourceType: job.resourceType,
        resourceKey: job.resourceKey,
        attempts: job.attempts,
        kind: 'cancelled',
        userId: job.userId,
      }));
    }
  }
}
