import { ModelsRegistryService } from './models-registry.service';

describe('ModelsRegistryService: ошибки источника', () => {
  it('не маскирует сбой запроса пустым реестром без unexpected', async () => {
    const pg = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    const service = new ModelsRegistryService(pg as any);

    await expect(service.getOverview()).rejects.toThrow('db down');
  });

  it('сохраняет обычный ответ при успешном запросе', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const service = new ModelsRegistryService(pg as any);

    const overview = await service.getOverview();
    expect(overview.expected.length).toBeGreaterThan(0);
    expect(overview.unexpected).toEqual([]);
  });
});
