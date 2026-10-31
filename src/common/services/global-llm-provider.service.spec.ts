import { GlobalLlmProviderService, GLOBAL_PROVIDER_CACHE_MS, LLM_SETTINGS_DDL } from './global-llm-provider.service';

const mk = (impl: (sql: string, params?: any[]) => any) => {
  const query = jest.fn(async (sql: string, params?: any[]) => impl(sql, params));
  return { svc: new GlobalLlmProviderService({ query } as any), query };
};
const row = (provider: unknown, extra: Record<string, unknown> = {}) => ({ rows: [{ value: { provider }, ...extra }] });

describe('GlobalLlmProviderService', () => {
  it('get: строки нет — claude', async () => {
    const { svc } = mk(() => ({ rows: [] }));
    expect(await svc.get()).toBe('claude');
  });

  it('get: qwen', async () => {
    const { svc } = mk(() => row('qwen'));
    expect(await svc.get()).toBe('qwen');
  });

  it('get: мусор в значении — claude', async () => {
    const { svc } = mk(() => row('gpt'));
    expect(await svc.get()).toBe('claude');
  });

  it('get: кэш 15 секунд — второй запрос в базу только после истечения', async () => {
    const { svc, query } = mk(() => row('kimi'));
    const t0 = 1_000_000;
    expect(await svc.get(t0)).toBe('kimi');
    expect(await svc.get(t0 + GLOBAL_PROVIDER_CACHE_MS - 1)).toBe('kimi');
    expect(query).toHaveBeenCalledTimes(1);
    await svc.get(t0 + GLOBAL_PROVIDER_CACHE_MS);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('get: сбой базы без прочитанного раньше значения — claude', async () => {
    const { svc } = mk(() => { throw new Error('db down'); });
    expect(await svc.get()).toBe('claude');
  });

  it('get: сбой базы после прочитанного qwen — qwen (не возвращаем всех на Claude молча)', async () => {
    let fail = false;
    const { svc } = mk(() => { if (fail) throw new Error('db down'); return row('qwen'); });
    const t0 = 2_000_000;
    expect(await svc.get(t0)).toBe('qwen');
    fail = true;
    expect(await svc.get(t0 + GLOBAL_PROVIDER_CACHE_MS + 1)).toBe('qwen');
  });

  it('get: лежащая база — второй запрос в пределах 15 с не ходит в базу повторно', async () => {
    const { svc, query } = mk(() => { throw new Error('db down'); });
    const t0 = 3_000_000;
    expect(await svc.get(t0)).toBe('claude');
    expect(await svc.get(t0 + GLOBAL_PROVIDER_CACHE_MS - 1)).toBe('claude');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('get: чтение, начатое до set(), не затирает записанное', async () => {
    let release!: (v: unknown) => void;
    const query = jest.fn()
      .mockImplementationOnce(() => new Promise((r) => { release = r; }))
      .mockResolvedValueOnce(row('claude'))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const svc = new GlobalLlmProviderService({ query } as any);
    const pending = svc.get();
    await svc.set('qwen', 'admin-1');
    release(row('claude'));
    await pending;
    expect(await svc.get()).toBe('qwen');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('set: upsert с актором; отдаёт прежнее значение; кэш сразу новый', async () => {
    const { svc, query } = mk((sql) => (/^SELECT value, updated_at/.test(sql) ? row('qwen') : { rows: [], rowCount: 1 }));
    const r = await svc.set('kimi', 'admin-1');
    expect(r).toEqual({ previous: 'qwen' });
    const upsert = query.mock.calls.find((c) => /INSERT INTO llm_settings/.test(c[0]))!;
    expect(upsert[0]).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    expect(upsert[1]).toEqual(['global_provider', JSON.stringify({ provider: 'kimi' }), 'admin-1']);
    query.mockClear();
    expect(await svc.get()).toBe('kimi');
    expect(query).not.toHaveBeenCalled();
  });

  it('set: сбой upsert — бросает, кэш не меняется', async () => {
    const t0 = 4_000_000;
    const { svc, query } = mk((sql) => {
      if (/^SELECT value, updated_at/.test(sql)) return row('qwen');
      if (/^SELECT value FROM/.test(sql)) return row('qwen');
      if (/INSERT INTO llm_settings/.test(sql)) throw new Error('db down');
      return { rows: [] };
    });
    expect(await svc.get(t0)).toBe('qwen');
    await expect(svc.set('kimi', 'admin-1', t0 + 1)).rejects.toThrow('db down');
    query.mockClear();
    expect(await svc.get(t0 + 2)).toBe('qwen');
    expect(query).not.toHaveBeenCalled();
  });

  it('set: недопустимая модель — бросает, в базу не пишет', async () => {
    const { svc, query } = mk(() => ({ rows: [] }));
    await expect(svc.set('gpt' as any, 'admin-1')).rejects.toThrow('llm_settings: недопустимая модель gpt');
    expect(query).not.toHaveBeenCalled();
  });

  it('status: сбой базы — бросает (не подставляем Claude молча в карточке)', async () => {
    const { svc } = mk(() => { throw new Error('db down'); });
    await expect(svc.status()).rejects.toThrow('db down');
  });

  it('status: модель, с какого момента и кто', async () => {
    const { svc } = mk(() => row('qwen', { updated_at: new Date('2026-10-31T13:40:00Z'), updated_by: 'admin-1' }));
    expect(await svc.status()).toEqual({ provider: 'qwen', since: '2026-10-31T13:40:00.000Z', by: 'admin-1' });
  });

  it('status: строки нет — claude, since и by пусты', async () => {
    const { svc } = mk(() => ({ rows: [] }));
    expect(await svc.status()).toEqual({ provider: 'claude', since: null, by: null });
  });

  it('onModuleInit: один DO под advisory-локом, CREATE TABLE IF NOT EXISTS llm_settings', async () => {
    const { svc, query } = mk(() => ({ rows: [] }));
    await svc.onModuleInit();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(LLM_SETTINGS_DDL);
    expect(LLM_SETTINGS_DDL).toMatch(/pg_advisory_xact_lock/);
    expect(LLM_SETTINGS_DDL).toMatch(/CREATE TABLE IF NOT EXISTS llm_settings/);
  });

  it('onModuleInit: сбой — не роняет старт', async () => {
    const { svc } = mk(() => { throw new Error('lock timeout'); });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});
