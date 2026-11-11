import { deriveRepairOutcome, repairStatusText } from './alert-bot.repair-outcome';

const exec = (id: string, mutates = true) => ({ id, kind: 'exec' as const, mutates, status: 'succeeded' as const, exitCode: 0, sequence: Number(id) });
const verify = (id: string, exitCode = 0) => ({ id, kind: 'verify' as const, mutates: false, status: exitCode === 0 ? 'succeeded' as const : 'failed' as const, exitCode, sequence: Number(id) });

describe('repair outcome', () => {
  it.each([
    { jobs: [exec('1'), verify('2')], model: 'completed' as const, status: 'verified' },
    { jobs: [exec('1')], model: 'completed' as const, status: 'unverified' },
    { jobs: [verify('1'), exec('2')], model: 'completed' as const, status: 'unverified' },
    { jobs: [exec('1'), verify('2', 1)], model: 'completed' as const, status: 'unverified' },
    { jobs: [exec('1'), verify('2')], model: 'failed' as const, status: 'verified' },
    { jobs: [exec('1')], model: 'failed' as const, status: 'failed' },
    { jobs: [], model: 'no_cause' as const, status: 'failed' },
    { jobs: [exec('1')], model: 'timeout' as const, status: 'timeout' },
    { jobs: [exec('1'), verify('2')], model: 'cancelled' as const, status: 'cancelled' },
  ])('$status', ({ jobs, model, status }) => {
    expect(deriveRepairOutcome(jobs, model).status).toBe(status);
  });

  it('не путает отсутствие изменений с исправлением', () => {
    expect(repairStatusText('verified', 1)).toBe('Исправлено и проверено');
    expect(repairStatusText('verified', 0)).toBe('Проверено: исправление не потребовалось');
    expect(repairStatusText('unverified', 1)).toBe('Выполнено, результат не подтверждён');
    expect(repairStatusText('failed', 0, true)).toBe('Не исправлено: причина не подтверждена');
  });
});
