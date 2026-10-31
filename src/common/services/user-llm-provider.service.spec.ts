import 'reflect-metadata';
import { UserLlmProviderService } from './user-llm-provider.service';
import { PgService } from './pg.service';
import { GlobalLlmProviderService } from './global-llm-provider.service';

const mk = (impl: (sql: string, params?: any[]) => any, global?: any) => {
  const query = jest.fn(async (sql: string, params?: any[]) => impl(sql, params));
  return { svc: new UserLlmProviderService({ query } as any, global), query };
};

describe('UserLlmProviderService', () => {
  it('get: qwen', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'qwen' }] }));
    expect(await svc.get('u-1')).toBe('qwen');
  });

  it('get: NULL — default', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: null }] }));
    expect(await svc.get('u-1')).toBe('default');
  });

  it('get: нет пользователя — default', async () => {
    const { svc } = mk(() => ({ rows: [] }));
    expect(await svc.get('nobody')).toBe('default');
  });

  it('get: сбой БД — default, без исключения', async () => {
    const { svc } = mk(() => { throw new Error('db down'); });
    expect(await svc.get('u-1')).toBe('default');
  });

  it('get: пустой userId — default без запроса', async () => {
    const { svc, query } = mk(() => ({ rows: [] }));
    expect(await svc.get('')).toBe('default');
    expect(query).not.toHaveBeenCalled();
  });

  it('set qwen — пишет qwen, true', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    expect(await svc.set('u-1', 'qwen')).toBe(true);
    expect(query.mock.calls[0][0]).toMatch(/UPDATE ai_profiles_consolidated SET llm_provider = \$2 WHERE user_id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['u-1', 'qwen']);
  });

  it('set claude — пишет claude (явный выбор)', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    await svc.set('u-1', 'claude');
    expect(query.mock.calls[0][1]).toEqual(['u-1', 'claude']);
  });

  it('set default — пишет NULL («Как у всех»)', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    await svc.set('u-1', 'default');
    expect(query.mock.calls[0][1]).toEqual(['u-1', null]);
  });

  it('get: claude в базе — claude', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'claude' }] }));
    expect(await svc.get('u-1')).toBe('claude');
  });

  it('route: личный выбор — он, choice user; рубильник не читается', async () => {
    const global = { get: jest.fn(async () => 'qwen') };
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'claude' }] }), global);
    expect(await svc.route('u-1')).toEqual({ provider: 'claude', choice: 'user' });
    expect(global.get).not.toHaveBeenCalled();
  });

  it('route: «Как у всех» — модель рубильника, choice global', async () => {
    const global = { get: jest.fn(async () => 'qwen') };
    const { svc } = mk(() => ({ rows: [{ llm_provider: null }] }), global);
    expect(await svc.route('u-1')).toEqual({ provider: 'qwen', choice: 'global' });
  });

  it('route: «Как у всех» без сервиса рубильника — claude, choice global', async () => {
    const { svc } = mk(() => ({ rows: [] }));
    expect(await svc.route('u-1')).toEqual({ provider: 'claude', choice: 'global' });
  });

  it('route: рубильник бросил исключение — claude, без исключения (вторая линия защиты сверх контракта GlobalLlmProviderService)', async () => {
    const global = { get: jest.fn(async () => { throw new Error('unexpected'); }) };
    const { svc } = mk(() => ({ rows: [{ llm_provider: null }] }), global);
    await expect(svc.route('u-1')).resolves.toEqual({ provider: 'claude', choice: 'global' });
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

  it('get: kimi', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'kimi' }] }));
    expect(await svc.get('u-1')).toBe('kimi');
  });

  it('get: незнакомое значение — default', async () => {
    const { svc } = mk(() => ({ rows: [{ llm_provider: 'gpt' }] }));
    expect(await svc.get('u-1')).toBe('default');
  });

  it('set kimi — пишет kimi', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    expect(await svc.set('u-1', 'kimi')).toBe(true);
    expect(query.mock.calls[0][1]).toEqual(['u-1', 'kimi']);
  });

  it('set: незнакомое значение — пишет NULL, как «Как у всех» (валидирует сам, не только контроллер)', async () => {
    const { svc, query } = mk(() => ({ rows: [], rowCount: 1 }));
    await svc.set('u-1', 'gpt' as any);
    expect(query.mock.calls[0][1]).toEqual(['u-1', null]);
  });
});

/**
 * Рубильник веб-чата не должен молча остаться на Claude, если граф DI не
 * нашёл GlobalLlmProviderService: конструктор объявляет его БЕЗ @Optional(),
 * чтобы Nest считал зависимость обязательной и валил старт при поломке графа
 * (ловит smoke на test, а не тишина на проде). design:paramtypes при этом не
 * видит сам декоратор @Optional() — он сторожит только то, что параметр
 * объявлен КЛАССОМ GlobalLlmProviderService, а не интерфейсом/Object (та же
 * ловушка, что в chat.service.guest-carry.spec.ts с RedisService) — это
 * необходимое условие, чтобы Nest вообще мог найти провайдер по типу.
 */
describe('UserLlmProviderService: DI-тип рубильника', () => {
  it('конструктор объявляет зависимости классами PgService и GlobalLlmProviderService', () => {
    expect(Reflect.getMetadata('design:paramtypes', UserLlmProviderService)).toEqual([PgService, GlobalLlmProviderService]);
  });
});
