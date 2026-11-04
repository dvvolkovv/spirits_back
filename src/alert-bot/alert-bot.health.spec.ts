import { AlertBotHealthService, HEALTH_SECTIONS, HealthSection } from './alert-bot.health';

type Stub = Record<string, jest.Mock>;

const sectionCases: Array<[HealthSection, number, string]> = [
  ['databases', 0, 'getDatabases'],
  ['sms', 2, 'getOverview'],
  ['nanobanana', 3, 'getOverview'],
  ['tg-bot', 4, 'getOverview'],
  ['payments', 5, 'getOverview'],
  ['quality', 6, 'getOverview'],
  ['claude', 7, 'getOverview'],
  ['geo', 8, 'getLatest'],
  ['backups', 9, 'getOverview'],
  ['models', 10, 'getOverview'],
  ['jobs', 11, 'getOverview'],
  ['replication', 12, 'getOverview'],
  ['neo4j-dr', 13, 'getOverview'],
  ['minio-dr', 14, 'getOverview'],
  ['synthetic', 1, 'getOverview'],
];

describe('разделы технического здоровья для бота алертов', () => {
  let sources: Stub[];
  let service: AlertBotHealthService;

  beforeEach(() => {
    sources = [
      { getNodeOverview: jest.fn(), getProbes: jest.fn(), getDatabases: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getLatest: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
      { getOverview: jest.fn() },
    ];
    for (const source of sources) {
      for (const stub of Object.values(source)) stub.mockResolvedValue({ status: 'healthy' });
    }
    sources[0].getNodeOverview.mockResolvedValue([{ node: 'prod' }]);
    sources[0].getProbes.mockResolvedValue([{ probe: 'api' }]);
    service = new AlertBotHealthService(
      sources[0] as any,
      sources[1] as any,
      sources[2] as any,
      sources[3] as any,
      sources[4] as any,
      sources[5] as any,
      sources[6] as any,
      sources[7] as any,
      sources[8] as any,
      sources[9] as any,
      sources[10] as any,
      sources[11] as any,
      sources[12] as any,
      sources[13] as any,
      sources[14] as any,
      sources[15] as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('перечисляет все 16 разделов', () => {
    expect(HEALTH_SECTIONS).toHaveLength(16);
    expect(new Set([...HEALTH_SECTIONS, ...sectionCases.map(([section]) => section), 'overview']).size).toBe(16);
  });

  it('overview объединяет узлы, пробы и время формирования', async () => {
    const result = await service.getSection('overview') as any;
    expect(result.nodes).toEqual([{ node: 'prod' }]);
    expect(result.probes).toEqual([{ probe: 'api' }]);
    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
    expect(sources[0].getNodeOverview).toHaveBeenCalledTimes(1);
    expect(sources[0].getProbes).toHaveBeenCalledTimes(1);
  });

  it.each(sectionCases)('%s вызывает %s', async (section, sourceIndex, method) => {
    const expected = { section };
    sources[sourceIndex][method].mockResolvedValue(expected);
    await expect(service.getSection(section)).resolves.toEqual(expected);
    expect(sources[sourceIndex][method]).toHaveBeenCalledTimes(1);
  });

  it('badSections видит плохие статусы, но не healthy, unknown и configured:false', async () => {
    const cyclic: any = { status: 'ok' };
    cyclic.self = cyclic;
    const values: Partial<Record<HealthSection, unknown>> = {
      overview: { status: 'down' },
      databases: { status: 'healthy' },
      sms: { status: 'unknown' },
      nanobanana: { configured: false },
      'tg-bot': [{ nested: { health: 'CRITICAL' } }],
      payments: { state: 'ok' },
      quality: cyclic,
    };
    jest.spyOn(service, 'getSection').mockImplementation(async (section) => values[section] ?? { status: 'good' });

    await expect(service.badSections()).resolves.toEqual(['overview', 'tg-bot']);
  });

  it('сбой одного источника возвращает source_failed и не мешает другим разделам', async () => {
    sources[2].getOverview.mockRejectedValue(new Error('СЕКРЕТ-ИЗ-ОТВЕТА'));
    await expect(service.getSection('sms')).resolves.toEqual({ error: 'source_failed' });
    await expect(service.getSection('tg-bot')).resolves.toEqual({ status: 'healthy' });
  });

  it('явный сбой источника попадает в badSections', async () => {
    sources[2].getOverview.mockRejectedValue(new Error('СЕКРЕТ-ИЗ-ОТВЕТА'));
    await expect(service.badSections()).resolves.toContain('sms');
  });

  it('бесконечный источник завершается source_failed по дедлайну', async () => {
    sources[2].getOverview.mockImplementation(() => new Promise(() => {}));
    const startedAt = Date.now();
    await expect(service.getSection('sms')).resolves.toEqual({ error: 'source_failed' });
    expect(Date.now() - startedAt).toBeLessThan(4000);
  }, 4500);
});
