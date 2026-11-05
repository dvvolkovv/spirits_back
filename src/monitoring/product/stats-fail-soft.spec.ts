import { FunnelService } from './funnel.service';
import { EconomyService } from './economy.service';
import { SummaryService } from './summary.service';
import { ProfileDepthService } from './profile-depth.service';

const FROM = '2026-11-04T00:00:00.000Z';
const TO = '2026-11-05T00:00:00.000Z';

function pgMock() {
  return { query: jest.fn() };
}

describe('product stats fail-soft metadata and cancellation', () => {
  it('funnel помечает упавший SQL-шаг source_failed вместо валидного нуля', async () => {
    const pg = pgMock();
    pg.query.mockRejectedValueOnce(new Error('events down')).mockResolvedValue({ rows: [] });
    const result = await new FunnelService(pg as any).getFunnel(FROM, TO, null);

    expect(result).toMatchObject({ error: 'source_failed' });
    expect(result.steps[0]).toMatchObject({ key: 'landing_view', error: 'source_failed' });
    expect(result.steps[1]).not.toHaveProperty('error');
  });

  it('funnel повторно выбрасывает abort из fail-soft catch', async () => {
    const pg = pgMock();
    const controller = new AbortController();
    const reason = new Error('funnel stop');
    controller.abort(reason);
    pg.query.mockRejectedValue(reason);

    await expect(new FunnelService(pg as any).getFunnel(FROM, TO, null, controller.signal))
      .rejects.toBe(reason);
  });

  it('economy помечает только затронутые SQL-разделы source_failed', async () => {
    const pg = pgMock();
    pg.query.mockRejectedValueOnce(new Error('payments down')).mockResolvedValue({ rows: [{
      rub: '0', cnt: '0', avg: '0', n: '0', total: '0', repeat: '0',
      dau: '0', wau: '0', mau: '0', signups: '0', activated: '0',
      day: '2026-11-05', payments: '0',
    }] });
    const result = await new EconomyService(pg as any).getOverview('7d');

    expect(result).toMatchObject({ error: 'source_failed' });
    expect(result.revenue).toMatchObject({ error: 'source_failed' });
    expect(result.engagement).not.toHaveProperty('error');
  });

  it('economy повторно выбрасывает abort из fail-soft catch', async () => {
    const pg = pgMock();
    const controller = new AbortController();
    const reason = new Error('economy stop');
    controller.abort(reason);
    pg.query.mockRejectedValue(reason);

    await expect(new EconomyService(pg as any).getOverview('7d', controller.signal))
      .rejects.toBe(reason);
  });

  it('summary помечает упавший SQL-индикатор source_failed', async () => {
    const pg = pgMock();
    pg.query.mockRejectedValueOnce(new Error('contact requests down')).mockResolvedValue({ rows: [{ v: 1 }] });
    const profileDepth = { getOverview: jest.fn().mockResolvedValue({ perUser: { avgPds: 50 } }) };
    const result = await new SummaryService(pg as any, profileDepth as any).getOverview();

    expect(result).toMatchObject({ error: 'source_failed' });
    expect(result.indicators.find((row) => row.id === 'accept_rate'))
      .toMatchObject({ error: 'source_failed' });
    expect(result.indicators.find((row) => row.id === 'margin')).not.toHaveProperty('error');
  });

  it('profile-depth повторно выбрасывает abort вместо пустой валидной статистики', async () => {
    const controller = new AbortController();
    const reason = new Error('profile depth stop');
    controller.abort(reason);
    const neo4j = { readRows: jest.fn().mockRejectedValue(reason) };

    await expect(new ProfileDepthService(neo4j as any).getOverview(controller.signal))
      .rejects.toBe(reason);
  });

  it('profile-depth не маскирует внутренний per-user сбой под валидный ноль', async () => {
    const failure = new Error('per-user neo4j down');
    const neo4j = {
      readRows: jest.fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(failure),
    };

    await expect(new ProfileDepthService(neo4j as any).getOverview()).rejects.toBe(failure);
    expect(neo4j.readRows).toHaveBeenCalledTimes(2);
  });

  it('summary помечает упавший PDS source_failed', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValue({ rows: [{ v: 1 }] });
    const profileDepth = { getOverview: jest.fn().mockRejectedValue(new Error('neo4j down')) };

    const result = await new SummaryService(pg as any, profileDepth as any).getOverview();

    expect(result).toMatchObject({ error: 'source_failed' });
    expect(result.indicators.find((row) => row.id === 'pds'))
      .toMatchObject({ error: 'source_failed' });
  });

  it.each(['sql', 'pds'])('summary повторно выбрасывает abort из %s fail-soft catch', async (source) => {
    const pg = pgMock();
    const controller = new AbortController();
    const reason = new Error(`summary ${source} stop`);
    controller.abort(reason);
    if (source === 'sql') pg.query.mockRejectedValue(reason);
    else pg.query.mockResolvedValue({ rows: [{ v: 1 }] });
    const profileDepth = {
      getOverview: jest.fn().mockImplementation(() => source === 'pds'
        ? Promise.reject(reason)
        : Promise.resolve({ perUser: { avgPds: 50 } })),
    };

    await expect(new SummaryService(pg as any, profileDepth as any).getOverview(controller.signal))
      .rejects.toBe(reason);
  });
});
