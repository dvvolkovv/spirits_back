import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { MODULE_METADATA, OPTIONAL_DEPS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AdminGlobalLlmController } from './admin-global-llm.controller';
import { AdminModule } from './admin.module';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => undefined) }));
import { sendTelegramAlert } from '../common/telegram-alert';

const mkRes = () => { const res: any = {}; res.status = jest.fn(() => res); res.json = jest.fn(() => res); return res; };
const status = (provider: string) => ({ provider, since: '2026-10-31T13:40:00.000Z', by: 'admin-1' });

describe('AdminGlobalLlmController', () => {
  const OLD = { qwen: process.env.QWEN_FALLBACK_API_KEY, kimi: process.env.KIMI_FALLBACK_API_KEY };
  const keys = (qwen: boolean, kimi: boolean) => {
    if (qwen) process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test'; else delete process.env.QWEN_FALLBACK_API_KEY;
    if (kimi) process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test'; else delete process.env.KIMI_FALLBACK_API_KEY;
  };
  afterEach(() => {
    if (OLD.qwen === undefined) delete process.env.QWEN_FALLBACK_API_KEY; else process.env.QWEN_FALLBACK_API_KEY = OLD.qwen;
    if (OLD.kimi === undefined) delete process.env.KIMI_FALLBACK_API_KEY; else process.env.KIMI_FALLBACK_API_KEY = OLD.kimi;
    (sendTelegramAlert as jest.Mock).mockClear();
    (sendTelegramAlert as jest.Mock).mockImplementation(async () => undefined);
    jest.restoreAllMocks();
  });

  it('закрыт JwtGuard + AdminGuard', () => {
    const guards = Reflect.getMetadata('__guards__', AdminGlobalLlmController) || [];
    expect(guards).toEqual(expect.arrayContaining([JwtGuard, AdminGuard]));
  });

  it('GET: статус и ключи', async () => {
    keys(true, false);
    const svc = { status: jest.fn(async () => status('qwen')), set: jest.fn() };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).get(res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ...status('qwen'), configured: { qwen: true, kimi: false } });
  });

  it('POST qwen: пишет с актором, лог, сообщение в группу, отдаёт новый статус целиком', async () => {
    keys(true, false);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { status: jest.fn(async () => status('qwen')), set: jest.fn(async () => ({ previous: 'claude' })) };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'qwen' }, res);
    expect(svc.set).toHaveBeenCalledWith('qwen', 'admin-1');
    expect(res.status).toHaveBeenCalledWith(200);
    // Тело ответа целиком — не только статус-код (ревью 01.11): провайдер,
    // since, by и ключи должны дойти до клиента, а не только HTTP 200.
    expect(res.json).toHaveBeenCalledWith({ ...status('qwen'), configured: { qwen: true, kimi: false } });
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('admin-1: claude → qwen');
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect((sendTelegramAlert as jest.Mock).mock.calls[0][0]).toContain('Модель ответов для всех: Qwen');
  });

  it('POST того же значения — без сообщения в группу', async () => {
    keys(true, false);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { status: jest.fn(async () => status('qwen')), set: jest.fn(async () => ({ previous: 'qwen' })) };
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'qwen' }, mkRes());
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('POST kimi без ключа — 409 no_key, ничего не пишет', async () => {
    keys(true, false);
    const svc = { status: jest.fn(), set: jest.fn() };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'kimi' }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'no_key', provider: 'kimi' });
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('POST чужого значения — 400', async () => {
    const svc = { status: jest.fn(), set: jest.fn() };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'gpt' }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "provider: 'claude' | 'qwen' | 'kimi'" });
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('POST claude — всегда можно (ключ не нужен)', async () => {
    keys(false, false);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { status: jest.fn(async () => status('claude')), set: jest.fn(async () => ({ previous: 'qwen' })) };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'claude' }, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('запись упала — сообщения нет', async () => {
    keys(true, false);
    const svc = { status: jest.fn(), set: jest.fn(async () => { throw new Error('db down'); }) };
    const res = mkRes();
    await expect(
      new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'qwen' }, res),
    ).rejects.toThrow('db down');
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('Telegram завис — ответ 200 сразу, set() не ждёт отправку', async () => {
    keys(true, false);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    (sendTelegramAlert as jest.Mock).mockImplementationOnce(() => new Promise(() => { /* никогда не разрешается */ }));
    const svc = { status: jest.fn(async () => status('qwen')), set: jest.fn(async () => ({ previous: 'claude' })) };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'qwen' }, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('сбой статуса после успешной записи — не 500, отвечает известными значениями', async () => {
    keys(true, false);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = { status: jest.fn(async () => { throw new Error('db down'); }), set: jest.fn(async () => ({ previous: 'claude' })) };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'qwen' }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ provider: 'qwen', since: null, by: 'admin-1', configured: { qwen: true, kimi: false } });
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('статус после записи не прочитан');
  });
});

/**
 * Незарегистрированный контроллер отдаёт 404 при зелёных юнит-тестах (как в
 * admin-products.controller.spec.ts) — метаданные гвардов и DI-тип этого не
 * видят.
 */
describe('AdminGlobalLlmController: регистрация и путь', () => {
  it('зарегистрирован в AdminModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminModule)).toContain(AdminGlobalLlmController);
  });

  it('путь — GET/POST admin/llm-provider', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminGlobalLlmController.prototype.get)).toBe('admin/llm-provider');
    expect(Reflect.getMetadata(PATH_METADATA, AdminGlobalLlmController.prototype.set)).toBe('admin/llm-provider');
  });
});

/**
 * Ручка рубильника не должна молча потерять зависимость: конструктор
 * объявляет GlobalLlmProviderService БЕЗ @Optional() (обязательная
 * зависимость — поломка DI валит старт приложения, а не тихо отвечает без
 * рубильника). design:paramtypes не видит сам декоратор @Optional(), но
 * фиксирует, что параметр объявлен именно классом GlobalLlmProviderService, а
 * не интерфейсом/type alias (иначе Nest не найдёт провайдер по типу Object) —
 * тот же приём, что в src/chat/llm-provider-di.spec.ts.
 */
describe('AdminGlobalLlmController: DI-тип рубильника', () => {
  it('конструктор объявляет зависимость классом GlobalLlmProviderService', () => {
    expect(Reflect.getMetadata('design:paramtypes', AdminGlobalLlmController)).toEqual([GlobalLlmProviderService]);
  });

  it('без @Optional() — ни один параметр не помечен необязательным', () => {
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, AdminGlobalLlmController)).toBeUndefined();
  });
});
