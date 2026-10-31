import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { AdminGlobalLlmController } from './admin-global-llm.controller';
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

  it('POST qwen: пишет с актором, лог, сообщение в группу, отдаёт новый статус', async () => {
    keys(true, false);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { status: jest.fn(async () => status('qwen')), set: jest.fn(async () => ({ previous: 'claude' })) };
    const res = mkRes();
    await new AdminGlobalLlmController(svc as any).set({ userId: 'admin-1' }, { provider: 'qwen' }, res);
    expect(svc.set).toHaveBeenCalledWith('qwen', 'admin-1');
    expect(res.status).toHaveBeenCalledWith(200);
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
});
