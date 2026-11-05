jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import { AlertBotStatusService } from './alert-bot.status';
import { AlertBotHealthService } from './alert-bot.health';

describe('сводка /status без модели', () => {
  const monitoring = { query: jest.fn() };
  const health = { badSections: jest.fn() };
  const support = { countActiveTickets: jest.fn(), countOverdueTickets: jest.fn() };
  const status = new AlertBotStatusService(monitoring as any, health as any, support as any);

  beforeEach(() => {
    jest.clearAllMocks();
    monitoring.query.mockResolvedValue([]);
    health.badSections.mockResolvedValue([]);
    support.countActiveTickets.mockResolvedValue({ escalated: 0, owner_handling: 0, ai_handling: 0 });
    support.countOverdueTickets.mockResolvedValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('сводка содержит горящие алерты, плохие разделы, тикеты и SLA', async () => {
    monitoring.query.mockImplementation(async (q) => q.startsWith('ALERTS_FOR_STATE')
      ? [{ metric: { alertname: 'ProbeFailed', instance: 'prod' }, value: [0, '1700000000'] }]
      : [{ metric: { alertname: 'ProbeFailed', instance: 'prod' }, value: [0, '1'] }]);
    health.badSections.mockResolvedValue(['claude', 'payments']);
    support.countActiveTickets.mockResolvedValue({ escalated: 2, owner_handling: 1, ai_handling: 3 });
    support.countOverdueTickets.mockResolvedValue(2);
    const text = await status.summary();
    expect(text).toContain('ProbeFailed — prod');
    expect(text).toContain('claude, payments');
    expect(text).toContain('escalated 2');
    expect(text).toContain('просрочено: 2');
  });

  it('недоступный Prometheus не мешает остальной сводке', async () => {
    monitoring.query.mockRejectedValue(new Error('loki raw СЕКРЕТ-ИЗ-ОТВЕТА'));
    const text = await status.summary();
    expect(text).toContain('Prometheus недоступен');
    expect(text).not.toContain('СЕКРЕТ-ИЗ-ОТВЕТА');
    expect(text).toContain('escalated');
  });

  it('сбой разделов здоровья не скрывает тикеты и не раскрывает ошибку', async () => {
    health.badSections.mockRejectedValue(new Error('СЕКРЕТ-ИЗ-ОТВЕТА'));
    const text = await status.summary();
    expect(text).toContain('Тех: данные недоступны');
    expect(text).toContain('Тикеты: escalated 0');
    expect(text).not.toContain('СЕКРЕТ-ИЗ-ОТВЕТА');
  });

  it('сбой поддержки не скрывает разделы здоровья и не раскрывает ошибку', async () => {
    health.badSections.mockResolvedValue(['claude']);
    support.countActiveTickets.mockRejectedValue(new Error('СЕКРЕТ-ИЗ-ОТВЕТА'));
    const text = await status.summary();
    expect(text).toContain('Тех: claude');
    expect(text).toContain('Тикеты: данные недоступны');
    expect(text).not.toContain('СЕКРЕТ-ИЗ-ОТВЕТА');
  });

  it('соединяет ALERTS и ALERTS_FOR_STATE по нормализованным меткам и показывает время', async () => {
    monitoring.query.mockImplementation(async (q) => {
      if (q === 'ALERTS{alertstate="firing"}') {
        return [{
          metric: {
            __name__: 'ALERTS', alertstate: 'firing', severity: 'critical',
            instance: 'prod', alertname: 'ProbeFailed', job: 'blackbox',
          },
          value: [0, '1'],
        }];
      }
      if (q === 'ALERTS_FOR_STATE') {
        return [{
          metric: {
            job: 'blackbox', alertname: 'ProbeFailed', instance: 'prod',
            severity: 'critical', __name__: 'ALERTS_FOR_STATE',
          },
          value: [0, '1700000000'],
        }];
      }
      throw new Error(`unexpected query: ${q}`);
    });

    const text = await status.summary();
    expect(text).toContain('ProbeFailed — prod (с 2023-11-14T22:13:20.000Z)');
  });

  it('timeout поддержки передаёт linked AbortSignal в оба count query', async () => {
    support.countActiveTickets.mockImplementation(() => new Promise(() => {}));
    support.countOverdueTickets.mockImplementation(() => new Promise(() => {}));

    const text = await status.summary();

    expect(text).toContain('Тикеты: данные недоступны');
    expect(support.countActiveTickets.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(support.countOverdueTickets.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(support.countActiveTickets.mock.calls[0][0].aborted).toBe(true);
    expect(support.countOverdueTickets.mock.calls[0][0].aborted).toBe(true);
  }, 4500);

  it('deadline реально abort-ит оба Prometheus query и health sections', async () => {
    const signals: AbortSignal[] = [];
    monitoring.query.mockImplementation((_query, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    health.badSections.mockImplementation((signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });

    const text = await status.summary();

    expect(text).toContain('Prometheus недоступен');
    expect(text).toContain('Тех: данные недоступны');
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  }, 4500);

  it('ограничивает бесконечные Prometheus, health и PG дедлайном', async () => {
    monitoring.query.mockImplementation(() => new Promise(() => {}));
    health.badSections.mockImplementation(() => new Promise(() => {}));
    support.countActiveTickets.mockImplementation(() => new Promise(() => {}));
    support.countOverdueTickets.mockImplementation(() => new Promise(() => {}));

    const startedAt = Date.now();
    const text = await status.summary();

    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(text).toContain('Prometheus недоступен');
    expect(text).toContain('Тех: данные недоступны');
    expect(text).toContain('Тикеты: данные недоступны');
  }, 4500);

  it('health.badSections передаёт внешний abort signal в каждый getSection', async () => {
    const health = Object.create(AlertBotHealthService.prototype) as AlertBotHealthService;
    const getSection = jest.fn().mockResolvedValue({ error: 'source_failed' });
    (health as any).getSection = getSection;
    const controller = new AbortController();

    await health.badSections(controller.signal);

    expect(getSection).toHaveBeenCalledTimes(16);
    expect(getSection.mock.calls.every((call) => call[1] === controller.signal)).toBe(true);
  });
});
