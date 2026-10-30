import { UserLlmProviderService } from './user-llm-provider.service';

const mk = (impl: (sql: string, params?: any[]) => any) => {
  const query = jest.fn(async (sql: string, params?: any[]) => impl(sql, params));
  return { svc: new UserLlmProviderService({ query } as any), query };
};

describe('UserLlmProviderService', () => {
  it('get: qwen', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'qwen' }] }));
    expect(await svc.get('79030169187')).toBe('qwen');
  });

  it('get: NULL — claude', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: null }] }));
    expect(await svc.get('79030169187')).toBe('claude');
  });

  it('get: нет пользователя — claude', async () => {
    const { svc } = mk(() => ({ rows: [] }));
    expect(await svc.get('nobody')).toBe('claude');
  });

  it('get: сбой БД — claude, без исключения', async () => {
    const { svc } = mk(() => { throw new Error('db down'); });
    expect(await svc.get('79030169187')).toBe('claude');
  });

  it('get: пустой userId — claude без запроса', async () => {
    const { svc, query } = mk(() => ({ rows: [] }));
    expect(await svc.get('')).toBe('claude');
    expect(query).not.toHaveBeenCalled();
  });

  it('set qwen — пишет qwen, true', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    expect(await svc.set('79030169187', 'qwen')).toBe(true);
    expect(query.mock.calls[0][0]).toMatch(/UPDATE ai_profiles_consolidated SET llm_provider = \$2 WHERE user_id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['79030169187', 'qwen']);
  });

  it('set claude — пишет NULL', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    await svc.set('79030169187', 'claude');
    expect(query.mock.calls[0][1]).toEqual(['79030169187', null]);
  });

  it('set: нет пользователя — false', async () => {
    const { svc } = mk(() => ({ rows: [], rowCount: 0 }));
    expect(await svc.set('nobody', 'qwen')).toBe(false);
  });

  it('onModuleInit: колонки нет — проверка information_schema (с учётом схемы), потом ALTER', async () => {
    const calls: string[] = [];
    const { svc, query } = mk((sql) => { calls.push(sql); return { rows: [] }; });
    await svc.onModuleInit();
    expect(calls[0]).toMatch(/information_schema\.columns/);
    // table_schema = 'public': без неё тот же столбец в чужой схеме (напр.
    // временной/staging) выдал бы ложный «колонка уже есть».
    expect(calls[0]).toMatch(/table_schema\s*=\s*'public'/);
    expect(calls[0]).toMatch(/ai_profiles_consolidated/);
    expect(calls[0]).toMatch(/llm_provider/);
    expect(calls[1]).toBe('ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS llm_provider text');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('onModuleInit: колонка уже есть — ALTER не выполняется (ACCESS EXCLUSIVE не берётся на каждом старте)', async () => {
    const { svc, query } = mk((sql) => (String(sql).includes('information_schema') ? { rows: [{ exists: 1 }] } : { rows: [] }));
    await svc.onModuleInit();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('onModuleInit: сбой проверки — не роняет старт', async () => {
    const bad = mk(() => { throw new Error('lock timeout'); });
    await expect(bad.svc.onModuleInit()).resolves.toBeUndefined();
  });
});
