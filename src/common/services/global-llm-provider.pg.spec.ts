import { Pool } from 'pg';
import { GlobalLlmProviderService, LLM_SETTINGS_DDL } from './global-llm-provider.service';

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
    // База общая для разных прогонов этого и будущих тестов — только чистим
    // данные за собой, таблицу не роняем.
    await pool.query('TRUNCATE llm_settings');
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

    // Новый экземпляр с пустым кэшем на том же пуле — значение идёт только из
    // SELECT, а не из кэша того же svc, который сам его туда только что положил.
    const fresh = new GlobalLlmProviderService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
    expect(await fresh.get()).toBe('qwen');

    const r = await svc.set('kimi', 'admin-1');
    expect(r).toEqual({ previous: 'qwen' });
  });

  it('мусор в значении, вставленный напрямую SQL, — claude', async () => {
    await pool.query(`INSERT INTO llm_settings (key, value) VALUES ('global_provider', '{"provider":"gpt"}'::jsonb)`);
    expect(await svc.get()).toBe('claude');
    expect((await svc.status()).provider).toBe('claude');
  });

  // Ревью 01.11: повторный клик по уже текущей модели в админке не должен
  // сбрасывать «с …» в подсказке под блоком и в суточном напоминании — WHERE
  // IS DISTINCT FROM в UPDATE должен молча не задеть строку, когда значение
  // не изменилось.
  it('повторный set того же значения — since/by не меняются (идемпотентная запись)', async () => {
    await svc.set('qwen', 'admin-1');
    const first = await svc.status();
    expect(first.since).not.toBeNull();

    const r = await svc.set('qwen', 'admin-2');
    expect(r).toEqual({ previous: 'qwen' });
    const second = await svc.status();
    expect(second.provider).toBe('qwen');
    expect(second.since).toBe(first.since);
    expect(second.by).toBe('admin-1'); // не затёрто новым актором admin-2
  });
});
