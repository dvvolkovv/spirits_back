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

/** Исходы задач одного прогона runAccount (сводка тика, ревью Task 25 п.4). */
export interface DeletionRunSummary {
  done: number;
  failed: number;
  cancelled: number;
  stale: number;
}
export type DeletionRunOutcome = keyof DeletionRunSummary;

export function emptyDeletionRunSummary(): DeletionRunSummary {
  return { done: 0, failed: 0, cancelled: 0, stale: 0 };
}

@Injectable()
export class AccountDeletionRunner {
  private readonly logger = new Logger(AccountDeletionRunner.name);

  constructor(
    private readonly pg: PgService,
    private readonly jobs: AccountDeletionJobs,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  /**
   * Исполняет задачи поколения по очереди claimNext. Исходы копятся в
   * summary (координатор передаёт свою сводку тика — счёт не теряется, даже
   * если прогон оборвётся исключением) и возвращаются.
   */
  async runAccount(
    deletionId: string,
    summary: DeletionRunSummary = emptyDeletionRunSummary(),
  ): Promise<DeletionRunSummary> {
    while (true) {
      const job = await this.jobs.claimNext(deletionId);
      if (!job) return summary;
      summary[await this.runClaimed(job)] += 1;
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
      await this.runClaimed(job);
    }
    await this.jobs.assertNoImmediateBlockers(deletionId);
  }

  /**
   * Task 18 — метод публичен: явный путь исполняет адресную задачу (core)
   * вне цикла claimNext. Done завершается сразу — повторному DELETE не нужно
   * повторно исполнять успешный core.
   *
   * T18-M1/M2 (ревью Task 18, фикс в Task 19): нормализация покрывает ВСЕ
   * статусы кроме done, включая running. Строка, полученная через find(),
   * НЕ заклеймена нами: running с живым lease означает конкурентное исполнение
   * (второй DELETE или тик воркера на поколении старше 30 дней), и адаптер
   * поверх него сломал бы инвариант «одного исполнителя» и задвоил внешние
   * вызовы (revoke, отвязки, рассылки). Такая строка проходит через claimById
   * и получает честный отказ: живой lease → null → DeletionRetryError('db') →
   * 503 «повторите позже» на явном пути; истёкший lease → claimById реклеймит
   * строку (attempts+1, свежий lease), и исполнение идёт как обычно.
   *
   * cancelled не клеймится, но исход НЕ retryable — это отмена (реактивация):
   * DeletionCancelledError, kind='cancelled' в логе (T18-M2).
   *
   * T19-M2 (ревью Task 19): отказ claimById при НЕ отменённой строке ещё не
   * значит, что исход retryable. Гонка «конкурент доделал задачу между
   * find(core) и runJob»: find() вернул pending/running, а к моменту claimById
   * строка уже done — и done не клеймится. Прежний код давал ложный
   * DeletionRetryError('db') при фактическом успехе (на явном пути — ложный
   * 503 и повторный DELETE). Поэтому после отказа перечитываем строку:
   * done — успешный выход без исполнения; исчезнувшая/недостижимая строка —
   * find сам бросит DeletionRetryError('db'), прежний исход.
   *
   * T20-M2(i) (ревью Task 20): та же гонка с противоположным исходом —
   * реактивация (Task 20) сняла поколение МЕЖДУ find(core) и runJob:
   * переданная строка ещё pending/running, но перечитывание даёт cancelled.
   * Такой исход — отмена, а не retryable: DeletionCancelledError, честный
   * kind='cancelled' в логе, и явный путь не предлагает «повторить позже»
   * для закрытого поколения (HTTP-исход deleteExplicit не меняется — 503).
   *
   * Заклеймленные строки (из claimNext/claimNextStop — всегда running с
   * СОБСТВЕННЫМ живым lease) через этот метод не ходят: их исполняет runClaimed
   * напрямую, иначе claimById отверг бы наш же lease. Поведение
   * runAccount/runImmediateStops не меняется.
   */
  async runJob(jobRow: DeletionJobRow): Promise<void> {
    if (jobRow.status === 'done') return;
    const claimed = await this.jobs.claimById(jobRow.id, jobRow.deletionId);
    if (!claimed) {
      if (jobRow.status === 'cancelled') throw new DeletionCancelledError();
      const fresh = await this.jobs.find(
        jobRow.deletionId,
        jobRow.resourceType,
        jobRow.resourceKey,
      );
      if (fresh.status === 'done') return;
      // T20-M2(i): перечитывание видит cancelled — поколение закрыто
      // реактивацией, исход терминальный, а не retryable.
      if (fresh.status === 'cancelled') throw new DeletionCancelledError();
      throw new DeletionRetryError('db');
    }
    await this.runClaimed(claimed);
  }

  /**
   * Исполнение строки, УЖЕ заклеймленной нами (running, собственный живой
   * lease, актуальные attempts): heartbeat, адаптер, finish/fail. Вход —
   * только из runAccount/runImmediateStops и из нормализованного runJob.
   */
  private async runClaimed(jobRow: DeletionJobRow): Promise<DeletionRunOutcome> {
    const job = jobRow;

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
      const recorded = await this.jobs.fail(job, kind);
      this.logger.warn(safeDeletionMessage({
        deletionId: job.deletionId,
        resourceType: job.resourceType,
        resourceKey: job.resourceKey,
        attempts: job.attempts,
        kind,
        userId: job.userId,
      }));
      if (!recorded) return 'stale';
      return kind === 'cancelled' ? 'cancelled' : 'failed';
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
      return 'stale';
    }
    return 'done';
  }
}
