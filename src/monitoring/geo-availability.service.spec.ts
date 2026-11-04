jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramPayload: jest.fn(async () => {}),
  telegramConfigured: jest.fn(() => false),
}));

import axios from 'axios';
import { GeoAvailabilityService } from './geo-availability.service';

const mockedPost = axios.post as jest.Mock;

function row(checkedAt: Date) {
  return {
    checked_at: checkedAt,
    target: 'linkeon.io',
    ru_total: 3,
    ru_ok: 3,
    ru_failed: 0,
    baseline_ok: true,
    region_down: false,
    probes: [],
  };
}

describe('GeoAvailabilityService: недоступный источник и старый результат', () => {
  afterEach(() => jest.restoreAllMocks());

  it('помечает старый healthy ответ после сбоя Globalping как stale/source_failed', async () => {
    mockedPost.mockRejectedValue(new Error('globalping down'));
    const pg = { query: jest.fn(async () => ({ rows: [row(new Date(Date.now() - 180 * 60_000))] })) };
    const service = new GeoAvailabilityService(pg as any);

    await service.run();
    const latest = await service.getLatest();

    expect(latest.region_down).toBe(false);
    expect(latest.stale).toBe(true);
    expect(latest.error).toBe('source_failed');
  });

  it('свежий успешно прочитанный результат остаётся healthy', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [row(new Date())] })) };
    const service = new GeoAvailabilityService(pg as any);

    await expect(service.getLatest()).resolves.toMatchObject({ stale: false, error: null });
  });
});
