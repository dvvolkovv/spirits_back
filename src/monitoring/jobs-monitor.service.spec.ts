import { JobsMonitorService } from './jobs-monitor.service';

describe('JobsMonitorService: ошибки источника', () => {
  it.each(['video_jobs', 'token_consumption_tasks', 'vpm_runs', 'ai_profiles_consolidated'])(
    'не маскирует сбой запроса %s здоровым пустым fallback',
    async (table) => {
      const pg = {
        query: jest.fn(async (sql: string) => {
          if (sql.includes(table)) throw new Error(`db down: ${table}`);
          return { rows: [] };
        }),
      };
      const service = new JobsMonitorService(pg as any);

      await expect(service.getOverview()).rejects.toThrow(`db down: ${table}`);
    },
  );

  it('сохраняет обычный пустой ответ при успешных запросах', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const service = new JobsMonitorService(pg as any);

    await expect(service.getOverview()).resolves.toMatchObject({
      video: { pending_total: 0, stuck: false },
      tokens: { pending_total: 0, stuck: false },
      vpm_recent: [],
      compaction: { active_profiles: 0 },
    });
  });
});
