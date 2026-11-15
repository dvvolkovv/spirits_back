import { AccountDeletionRunner } from './account-deletion.runner';
import { DeletionCancelledError, DeletionRetryError } from './account-deletion.safe';
import type { DeletionJobRow } from './account-deletion.types';

/**
 * T18-M1/M2 (ревью Task 18, фиксы в Task 19) — нормализация runJob для
 * незаклеймленных строк.
 *
 * runJob публичен: явный путь передаёт ему строку из find() — НЕ заклеймленную
 * нами. Прежняя реализация исполняла status='running' напрямую, без claimById:
 *  - running с ЖИВЫМ lease означает конкурентное исполнение (второй DELETE или
 *    воркер на поколении ≥30 дней) — адаптер исполнялся бы вторым потоком
 *    без lease, ломая инвариант «одного исполнителя»;
 *  - cancelled-строка давала retry('db'), хотя исход не retryable, а
 *    отмена (реактивация) — kind в логе врал.
 *
 * Контракт после фикса:
 *  - running + живой lease (claimById → null): DeletionRetryError('db'),
 *    адаптер молчит;
 *  - running + истёкший lease (claimById реклеймит): исполнение ЗАКЛЕЙМЕННОЙ
 *    строкой (attempts/lease свежие);
 *  - cancelled: DeletionCancelledError(kind='cancelled'), адаптер молчит;
 *  - done: немедленный return без claim (без изменения).
 *
 * Строки из claimNext/claimNextStop (всегда running с собственным живым lease)
 * идут в исполнение МИНУЯ нормализацию — иначе claimById отверг бы наш же
 * lease: поведение runAccount/runImmediateStops не меняется.
 */

const USER = 'u-deleted';
const DELETION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

function makeRow(overrides: Partial<DeletionJobRow> = {}): DeletionJobRow {
  return {
    id: 'job-1',
    deletionId: DELETION_ID,
    userId: USER,
    resourceType: 'account.core.immediate',
    resourceKey: 'account',
    phase: 'immediate',
    payload: {},
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date(),
    leaseUntil: new Date(Date.now() + 300_000),
    lastErrorKind: null,
    ...overrides,
  };
}

function makeStack(claimResult: DeletionJobRow | null) {
  const executed: DeletionJobRow[] = [];
  const jobs = {
    claimById: jest.fn(async () => claimResult),
    heartbeat: jest.fn(async () => true),
    finish: jest.fn(async () => true),
    fail: jest.fn(async () => true),
    assertCurrent: jest.fn(async () => undefined),
  };
  const registry = {
    getExecutor: () => ({
      execute: async (job: DeletionJobRow) => {
        executed.push(job);
      },
    }),
  };
  const runner = new AccountDeletionRunner({} as any, jobs as any, registry as any);
  return { runner, jobs, registry, executed };
}

describe('runJob — нормализация незаклеймленных строк (T18-M1/M2, unit)', () => {
  it('running с живым lease — адаптер не исполняется, retry(db)', async () => {
    const row = makeRow({
      status: 'running',
      attempts: 1,
      leaseUntil: new Date(Date.now() + 300_000),
    });
    const { runner, jobs, executed } = makeStack(null);

    const error = await runner.runJob(row).catch((e) => e);

    expect(error).toBeInstanceOf(DeletionRetryError);
    expect((error as DeletionRetryError).kind).toBe('db');
    expect(executed).toEqual([]);
    // Нормализация обязана идти через claimById — только он знает про lease.
    expect(jobs.claimById).toHaveBeenCalledWith(row.id, row.deletionId);
  });

  it('running с истёкшим lease — реклейм и исполнение заклеймленной строкой', async () => {
    const stale = makeRow({
      status: 'running',
      attempts: 1,
      leaseUntil: new Date(Date.now() - 1_000),
    });
    const claimed = makeRow({
      status: 'running',
      attempts: 2,
      leaseUntil: new Date(Date.now() + 300_000),
    });
    const { runner, jobs, executed } = makeStack(claimed);

    await runner.runJob(stale);

    expect(jobs.claimById).toHaveBeenCalledWith(stale.id, stale.deletionId);
    // Адаптер и finish получают ЗАКЛЕЙМЛЕННУЮ строку: heartbeat/finish
    // матчатся по attempts, и работать они должны со свежим значением.
    expect(executed).toEqual([claimed]);
    expect(jobs.finish).toHaveBeenCalledWith(claimed);
  });

  it('cancelled-строка — DeletionCancelledError(kind=cancelled), не retry(db)', async () => {
    const row = makeRow({ status: 'cancelled', attempts: 3, leaseUntil: null });
    const { runner, executed } = makeStack(null);

    const error = await runner.runJob(row).catch((e) => e);

    expect(error).toBeInstanceOf(DeletionCancelledError);
    expect((error as DeletionCancelledError).kind).toBe('cancelled');
    expect(executed).toEqual([]);
  });

  it('done — немедленный return без claim (без изменения)', async () => {
    const row = makeRow({ status: 'done', attempts: 1, leaseUntil: null });
    const { runner, jobs, executed } = makeStack(null);

    await expect(runner.runJob(row)).resolves.toBeUndefined();
    expect(jobs.claimById).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });
});
