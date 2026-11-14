import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { AccountDeletionJobs } from './account-deletion.jobs';
import { AccountDeletionRegistry } from './account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
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

  /**
   * Task 18 — синхронное исполнение immediate-стопов одного поколения для
   * явного DELETE: HTTP-запрос не отдаёт управление почасовому воркеру,
   * человек ждёт ответа. Цикл идёт, пока stop-очередь поколения выдаёт
   * задачи (claimNextStop не трогает core), затем контрольный
   * assertNoImmediateBlockers: runJob ГЛОТАЕТ ошибки адаптеров (jobs.fail +
   * safe warn + return), поэтому «очередь пуста» само по себе не означает
   * «все стопы успешны». Проверка превращает незавершённый stop в
   * retryable-исход, который lifecycle транслирует в честный 503.
   */
  async runImmediateStops(deletionId: string): Promise<void> {
    while (true) {
      const job = await this.jobs.claimNextStop(deletionId);
      if (!job) break;
      await this.runJob(job);
    }
    await this.jobs.assertNoImmediateBlockers(deletionId);
  }

  /**
   * Task 18 — метод публичен: явный путь исполняет адресную задачу (core)
   * вне цикла claimNext. Нерunning-строка нормализуется через claimById
   * (явный retry обходит backoff); done завершается сразу — повторному
   * DELETE не нужно повторно исполнять успешный core. Неclaimable-строку
   * (cancelled после реактивации, чужой живой lease) НЕЛЬЗЯ молча пропустить
   * — это выглядело бы как успех: бросаем retryable-ошибку.
   *
   * Для runAccount поведение прежнее: claimNext всегда отдаёт running-строку,
   * нормализация не срабатывает.
   */
  async runJob(jobRow: DeletionJobRow): Promise<void> {
    let job = jobRow;
    if (job.status === 'done') return;
    if (job.status !== 'running') {
      const claimed = await this.jobs.claimById(job.id, job.deletionId);
      if (!claimed) throw new DeletionRetryError('db');
      job = claimed;
    }

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
