import { deriveRepairOutcome, repairStatusText } from './alert-bot.repair-outcome';

const exec = (id: string, mutates = true, status: 'succeeded' | 'failed' | 'running' | 'interrupted' = 'succeeded') => ({ id, kind: 'exec' as const, mutates, status, exitCode: status === 'succeeded' ? 0 : status === 'failed' ? 1 : null, sequence: Number(id) });
const verify = (id: string, exitCode: number | null = 0, status?: 'succeeded' | 'failed' | 'interrupted') => ({ id, kind: 'verify' as const, mutates: false, status: status ?? (exitCode === 0 ? 'succeeded' as const : 'failed' as const), exitCode, sequence: Number(id) });

describe('repair outcome', () => {
  it.each([
    { jobs: [exec('1'), verify('2')], model: 'completed' as const, status: 'verified' },
    { jobs: [exec('1')], model: 'completed' as const, status: 'unverified' },
    { jobs: [verify('1'), exec('2')], model: 'completed' as const, status: 'unverified' },
    { jobs: [exec('1'), verify('2', 1)], model: 'completed' as const, status: 'failed' },
    { jobs: [exec('1'), verify('2')], model: 'failed' as const, status: 'verified' },
    { jobs: [exec('1')], model: 'failed' as const, status: 'failed' },
    { jobs: [], model: 'no_cause' as const, status: 'failed' },
    { jobs: [exec('1')], model: 'timeout' as const, status: 'timeout' },
    { jobs: [exec('1'), verify('2')], model: 'cancelled' as const, status: 'cancelled' },
    { jobs: [exec('1'), verify('2'), verify('3', 1)], model: 'completed' as const, status: 'failed' },
    { jobs: [exec('1'), verify('2'), verify('3', null, 'interrupted')], model: 'completed' as const, status: 'interrupted' },
    { jobs: [exec('1', true, 'failed')], model: 'completed' as const, status: 'failed' },
    { jobs: [exec('1', true, 'running')], model: 'completed' as const, status: 'interrupted' },
    { jobs: [exec('1', true, 'interrupted')], model: 'completed' as const, status: 'interrupted' },
    { jobs: [exec('1'), verify('2', 1), verify('3')], model: 'completed' as const, status: 'verified' },
    { jobs: [exec('1', true, 'interrupted'), verify('2')], model: 'completed' as const, status: 'verified' },
    { jobs: [exec('1'), verify('2'), exec('3', false)], model: 'completed' as const, status: 'verified' },
    { jobs: [exec('1', true, 'running')], model: 'cancelled' as const, status: 'interrupted' },
  ])('$status', ({ jobs, model, status }) => {
    expect(deriveRepairOutcome(jobs, model).status).toBe(status);
  });

  it('не путает отсутствие изменений с исправлением', () => {
    expect(repairStatusText('verified', 1)).toBe('Исправлено и проверено');
    expect(repairStatusText('verified', 0)).toBe('Проверено: исправление не потребовалось');
    expect(repairStatusText('unverified', 1)).toBe('Выполнено, результат не подтверждён');
    expect(repairStatusText('failed', 0, true)).toBe('Не исправлено: причина не подтверждена');
  });

  it('связывает mutationCount с текстом итога', () => {
    const mutating = deriveRepairOutcome([exec('1'), verify('2')], 'completed');
    expect(mutating.mutationCount).toBe(1);
    expect(repairStatusText(mutating.status, mutating.mutationCount)).toBe('Исправлено и проверено');

    const nonMutating = deriveRepairOutcome([exec('1', false), verify('2')], 'completed');
    expect(nonMutating.mutationCount).toBe(0);
    expect(repairStatusText(nonMutating.status, nonMutating.mutationCount)).toBe('Проверено: исправление не потребовалось');

    const failedExec = deriveRepairOutcome([exec('1', true, 'failed')], 'completed');
    expect(failedExec.mutationCount).toBe(1);
    expect(repairStatusText(failedExec.status, failedExec.mutationCount)).toBe('Не исправлено');
  });

  it('running remote job имеет приоритет над cancelled модели', () => {
    const remote = { ...exec('1', true, 'running'), host: 'relay' };
    expect(deriveRepairOutcome([remote], 'cancelled')).toEqual({ status: 'interrupted', mutationCount: 1 });
    expect(deriveRepairOutcome([exec('1'), verify('2')], 'cancelled').status).toBe('cancelled');
  });

  it.each(['remote_outcome_unknown', 'process_close_unconfirmed'])('%s не исчезает после late admin stop', (failureKind) => {
    const unknown = { ...exec('1', true, 'interrupted'), failureKind };

    expect(deriveRepairOutcome([unknown, verify('2')], 'cancelled').status).toBe('interrupted');
    expect(deriveRepairOutcome([unknown, verify('2')], 'completed').status).toBe('verified');
    expect(deriveRepairOutcome([exec('1'), verify('2')], 'cancelled').status).toBe('cancelled');
  });
});
