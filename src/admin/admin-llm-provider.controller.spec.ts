import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { AdminLlmProviderController } from './admin-llm-provider.controller';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { UserLlmProviderService } from '../common/services/user-llm-provider.service';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';

const mkRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('AdminLlmProviderController', () => {
  /** Рубильник в теле ответа (global) — в большинстве тестов не важен: стоит на Claude. */
  const global = { get: jest.fn(async () => 'claude') };
  const OLD = { qwen: process.env.QWEN_FALLBACK_API_KEY, kimi: process.env.KIMI_FALLBACK_API_KEY };
  /** Какие ключи запасных заданы на бэкенде. */
  const keys = (qwen: boolean, kimi: boolean) => {
    if (qwen) process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test'; else delete process.env.QWEN_FALLBACK_API_KEY;
    if (kimi) process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test'; else delete process.env.KIMI_FALLBACK_API_KEY;
  };
  afterEach(() => {
    if (OLD.qwen === undefined) delete process.env.QWEN_FALLBACK_API_KEY; else process.env.QWEN_FALLBACK_API_KEY = OLD.qwen;
    if (OLD.kimi === undefined) delete process.env.KIMI_FALLBACK_API_KEY; else process.env.KIMI_FALLBACK_API_KEY = OLD.kimi;
  });

  it('закрыт JwtGuard + AdminGuard', () => {
    const guards = Reflect.getMetadata('__guards__', AdminLlmProviderController) || [];
    expect(guards).toEqual(expect.arrayContaining([JwtGuard, AdminGuard]));
  });

  it('GET: выбор и ключи по каждому запасному (+ прежнее qwenConfigured)', async () => {
    keys(true, false);
    const svc = { get: jest.fn(async () => 'kimi'), set: jest.fn(), route: jest.fn(async () => ({ provider: 'kimi', choice: 'user' })) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any, global as any).get('u-1', res);
    expect(svc.get).toHaveBeenCalledWith('u-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      userId: 'u-1', provider: 'kimi', effective: 'claude', global: 'claude', qwenConfigured: true, configured: { qwen: true, kimi: false },
    });
  });

  it('GET без ключей — всё false', async () => {
    keys(false, false);
    const svc = { get: jest.fn(async () => 'claude'), set: jest.fn(), route: jest.fn(async () => ({ provider: 'claude', choice: 'global' })) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any, global as any).get('u-1', res);
    expect(res.json).toHaveBeenCalledWith({
      userId: 'u-1', provider: 'claude', effective: 'claude', global: 'claude', qwenConfigured: false, configured: { qwen: false, kimi: false },
    });
  });

  it('POST kimi: сохраняет и отдаёт новое значение', async () => {
    keys(false, true);
    const svc = { get: jest.fn(), set: jest.fn(async () => true), route: jest.fn(async () => ({ provider: 'kimi', choice: 'user' })) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any, global as any).set('u-1', { userId: 'admin-1' }, { provider: 'kimi' }, res);
    expect(svc.set).toHaveBeenCalledWith('u-1', 'kimi');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      userId: 'u-1', provider: 'kimi', effective: 'kimi', global: 'claude', qwenConfigured: false, configured: { qwen: false, kimi: true },
    });
  });

  it('POST: чужое значение — 400 со списком допустимых, ничего не пишет', async () => {
    const svc = { get: jest.fn(), set: jest.fn(), route: jest.fn(async () => ({ provider: 'claude', choice: 'global' })) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any, global as any).set('u-1', { userId: 'admin-1' }, { provider: 'gpt' }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "provider: 'default' | 'claude' | 'qwen' | 'kimi'" });
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('POST: нет пользователя — 404', async () => {
    const svc = { get: jest.fn(), set: jest.fn(async () => false), route: jest.fn(async () => ({ provider: 'claude', choice: 'global' })) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any, global as any).set('nobody', { userId: 'admin-1' }, { provider: 'claude' }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('POST: успешная смена — лог с актором, пользователем и значением', async () => {
    keys(false, false);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { get: jest.fn(), set: jest.fn(async () => true), route: jest.fn(async () => ({ provider: 'kimi', choice: 'user' })) };
    await new AdminLlmProviderController(svc as any, global as any).set('u-1', { userId: 'admin-1' }, { provider: 'kimi' }, mkRes());
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('admin-1 → u-1 = kimi');
    log.mockRestore();
  });

  it('POST: без user (@CurrentUser не отдал) — актор unknown, лог всё равно пишется', async () => {
    keys(false, false);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { get: jest.fn(), set: jest.fn(async () => true), route: jest.fn(async () => ({ provider: 'claude', choice: 'global' })) };
    await new AdminLlmProviderController(svc as any, global as any).set('u-1', undefined, { provider: 'claude' }, mkRes());
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('unknown → u-1 = claude');
    log.mockRestore();
  });

  it('POST: отказ (400/404) — лог не пишется', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { get: jest.fn(), set: jest.fn(async () => false), route: jest.fn(async () => ({ provider: 'claude', choice: 'global' })) };
    await new AdminLlmProviderController(svc as any, global as any).set('nobody', { userId: 'admin-1' }, { provider: 'claude' }, mkRes());
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('GET: «Как у всех» при рубильнике Qwen — provider default, effective qwen, global qwen', async () => {
    keys(true, false);
    const svc = { get: jest.fn(async () => 'default'), set: jest.fn(), route: jest.fn(async () => ({ provider: 'qwen', choice: 'global' })) };
    const g = { get: jest.fn(async () => 'qwen') };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any, g as any).get('u-1', res);
    expect(res.json).toHaveBeenCalledWith({
      userId: 'u-1', provider: 'default', effective: 'qwen', global: 'qwen', qwenConfigured: true, configured: { qwen: true, kimi: false },
    });
  });

  it('POST default — пишет «Как у всех»', async () => {
    keys(false, false);
    const svc = { get: jest.fn(), set: jest.fn(async () => true), route: jest.fn(async () => ({ provider: 'claude', choice: 'global' })) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any, { get: jest.fn(async () => 'claude') } as any).set('u-1', { userId: 'admin-1' }, { provider: 'default' }, res);
    expect(svc.set).toHaveBeenCalledWith('u-1', 'default');
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

/**
 * Карточка пользователя не должна молча остаться без effective/global, если
 * граф DI не нашёл GlobalLlmProviderService: второй параметр объявлен без
 * @Optional() (TS-опциональность «?» сохранена ради юнит-тестов, которые
 * создают контроллер через `new` с одним аргументом). design:paramtypes не
 * видит сам декоратор @Optional() и не видит «?» — он фиксирует только тип
 * параметра, поэтому должен быть классом GlobalLlmProviderService, а не
 * интерфейсом/Object (тот же приём, что в src/chat/llm-provider-di.spec.ts и
 * user-llm-provider.service.spec.ts).
 */
describe('AdminLlmProviderController: DI-тип', () => {
  it('конструктор объявляет зависимости классами UserLlmProviderService и GlobalLlmProviderService', () => {
    expect(Reflect.getMetadata('design:paramtypes', AdminLlmProviderController)).toEqual([UserLlmProviderService, GlobalLlmProviderService]);
  });
});
