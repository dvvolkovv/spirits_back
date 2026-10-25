import { InsightsCron } from './insights.cron';

function harness(enabled: boolean) {
  const store = {
    reapStale: jest.fn(async () => 0),
    isEnabled: jest.fn(async () => enabled),
    duePostponed: jest.fn(async () => [{ id: 'r1', week_start: '2026-10-19', status: 'postponed', attempts: 1, manual: false }]),
  };
  const insights = { runScheduled: jest.fn(), retry: jest.fn() };
  return { cron: new InsightsCron(store as any, insights as any), store, insights };
}

describe('расписание «Затыков недели»', () => {
  it('выключено — оборванные закрываются, прогона нет', async () => {
    const h = harness(false);
    await h.cron.weekly();
    expect(h.store.reapStale).toHaveBeenCalled();
    expect(h.insights.runScheduled).not.toHaveBeenCalled();
  });

  it('включено — прогон прошлой недели', async () => {
    const h = harness(true);
    await h.cron.weekly();
    expect(h.insights.runScheduled).toHaveBeenCalledWith(expect.objectContaining({ weekStart: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }));
  });

  it('отложенные повторяются', async () => {
    const h = harness(true);
    await h.cron.retryPostponed();
    expect(h.insights.retry).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
  });

  it('сбой внутри не роняет крон', async () => {
    const h = harness(true);
    h.insights.runScheduled.mockRejectedValue(new Error('boom'));
    await expect(h.cron.weekly()).resolves.toBeUndefined();
  });
});
