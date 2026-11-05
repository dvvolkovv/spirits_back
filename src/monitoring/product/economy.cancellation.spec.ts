import { EconomyService } from './economy.service';

describe('EconomyService cancellation', () => {
  it('передаёт AbortSignal в каждый внутренний pg.query', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const service = new EconomyService(pg as any);
    const controller = new AbortController();

    await service.getOverview('30d', controller.signal);

    expect(pg.query.mock.calls.length).toBeGreaterThanOrEqual(9);
    for (const call of pg.query.mock.calls) {
      expect(call[2]).toBe(controller.signal);
    }
  });
});
