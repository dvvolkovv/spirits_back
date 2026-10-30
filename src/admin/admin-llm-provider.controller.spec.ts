import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { AdminLlmProviderController } from './admin-llm-provider.controller';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';

const mkRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('AdminLlmProviderController', () => {
  const OLD = process.env.QWEN_FALLBACK_API_KEY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.QWEN_FALLBACK_API_KEY;
    else process.env.QWEN_FALLBACK_API_KEY = OLD;
  });

  it('закрыт JwtGuard + AdminGuard', () => {
    const guards = Reflect.getMetadata('__guards__', AdminLlmProviderController) || [];
    expect(guards).toEqual(expect.arrayContaining([JwtGuard, AdminGuard]));
  });

  it('GET: выбор и наличие ключа', async () => {
    process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
    const svc = { get: jest.fn(async () => 'qwen'), set: jest.fn() };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).get('79030169187', res);
    expect(svc.get).toHaveBeenCalledWith('79030169187');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ userId: '79030169187', provider: 'qwen', qwenConfigured: true });
  });

  it('GET без ключа — qwenConfigured: false', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    const svc = { get: jest.fn(async () => 'claude'), set: jest.fn() };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).get('u1', res);
    expect(res.json).toHaveBeenCalledWith({ userId: 'u1', provider: 'claude', qwenConfigured: false });
  });

  it('POST: сохраняет и отдаёт новое значение', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    const svc = { get: jest.fn(), set: jest.fn(async () => true) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('79030169187', { userId: 'admin-1' }, { provider: 'qwen' }, res);
    expect(svc.set).toHaveBeenCalledWith('79030169187', 'qwen');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ userId: '79030169187', provider: 'qwen', qwenConfigured: false });
  });

  it('POST: чужое значение — 400, ничего не пишет', async () => {
    const svc = { get: jest.fn(), set: jest.fn() };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('u1', { userId: 'admin-1' }, { provider: 'gpt' }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it('POST: нет пользователя — 404', async () => {
    const svc = { get: jest.fn(), set: jest.fn(async () => false) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('nobody', { userId: 'admin-1' }, { provider: 'claude' }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  // Раньше смена модели ответов по аккаунту не оставляла следа — кто и когда
  // переключил пользователя на Qwen (тратит квоту владельца), было не выяснить.
  it('POST: успешная смена — лог с актором, пользователем и значением', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { get: jest.fn(), set: jest.fn(async () => true) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('79030169187', { userId: 'admin-1' }, { provider: 'qwen' }, res);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('admin-1 → 79030169187 = qwen');
    log.mockRestore();
  });

  it('POST: без user (@CurrentUser не отдал) — актор unknown, лог всё равно пишется', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { get: jest.fn(), set: jest.fn(async () => true) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('79030169187', undefined, { provider: 'claude' }, res);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('unknown → 79030169187 = claude');
    log.mockRestore();
  });

  it('POST: отказ (400/404) — лог не пишется', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = { get: jest.fn(), set: jest.fn(async () => false) };
    const res = mkRes();
    await new AdminLlmProviderController(svc as any).set('nobody', { userId: 'admin-1' }, { provider: 'claude' }, res);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
