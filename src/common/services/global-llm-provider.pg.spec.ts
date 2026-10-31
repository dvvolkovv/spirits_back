import { Pool } from 'pg';
import { GLOBAL_PROVIDER_CACHE_MS, GlobalLlmProviderService, LLM_SETTINGS_DDL } from './global-llm-provider.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('общий рубильник модели против живого Postgres', () => {
  jest.setTimeout(15_000);
  let pool: Pool;
  let svc: GlobalLlmProviderService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await pool.query(LLM_SETTINGS_DDL);
    await pool.query(LLM_SETTINGS_DDL); // повторный старт API — без ошибок
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE llm_settings');
    svc = new GlobalLlmProviderService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  afterAll(async () => {
    // Таблицу создали мы сами (DDL в beforeAll) — убираем за собой, чтобы в
    // общей для нескольких задач gls_test не копились чужие для них объекты.
    // Саму базу gls_test не трогаем — её удаление не входит в эту задачу.
    await pool.query('DROP TABLE IF EXISTS llm_settings');
    await pool.end();
  });

  it('пустая таблица — get()/status() отдают claude без since и by', async () => {
    expect(await svc.get()).toBe('claude');
    expect(await svc.status()).toEqual({ provider: 'claude', since: null, by: null });
  });

  it('set сохраняет модель и актора; status отдаёт их; повторный set отдаёт прежнее значение', async () => {
    await svc.set('qwen', 'admin-1');
    const afterFirst = await svc.status();
    expect(afterFirst.provider).toBe('qwen');
    expect(afterFirst.since).not.toBeNull();
    expect(afterFirst.by).toBe('admin-1');

    const r = await svc.set('kimi', 'admin-1');
    expect(r).toEqual({ previous: 'qwen' });
  });

  it('мусор в значении, вставленный напрямую SQL, — claude после истечения кэша', async () => {
    await pool.query(`INSERT INTO llm_settings (key, value) VALUES ('global_provider', '{"provider":"gpt"}'::jsonb)`);
    const t0 = Date.now();
    expect(await svc.get(t0 + GLOBAL_PROVIDER_CACHE_MS)).toBe('claude');
  });
});
