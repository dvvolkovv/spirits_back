import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AdminController } from './admin.controller';

/**
 * Проводка фильтров раздела «Звонки» от query-параметров до сервиса.
 *
 * Сервис фильтры разбирает сам, но только те, что до него доехали: забытый
 * здесь includeTest молча вернул бы пустой раздел встреч на проде, где все
 * встречи — прогоны владельца. Защиту маршрутов держит
 * common/guards/admin-routes.spec.ts — он обходит все методы контроллера.
 */

/** Фейковый express Response: запоминает статус и тело. */
function fakeRes() {
  const r: any = { statusCode: 0, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

describe('AdminController: звонки и встречи', () => {
  it('лента объявлена как GET admin/calls/sessions', () => {
    const handler = AdminController.prototype.callSessions;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('admin/calls/sessions');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  });

  it('лента передаёт в сервис все фильтры', async () => {
    const svc = { getCallSessions: jest.fn().mockResolvedValue({ sessions: [] }) };
    const ctrl = new AdminController(svc as any, {} as any);
    const res = fakeRes();
    await ctrl.callSessions('90', 'meeting', 'zoom', '1', '100', res);

    expect(svc.getCallSessions).toHaveBeenCalledWith({
      days: 90, kind: 'meeting', provider: 'zoom', includeTest: true, limit: 100,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
  });

  it('таблица принимает площадку и тестовые', async () => {
    const svc = { getCallsByUser: jest.fn().mockResolvedValue({}) };
    const ctrl = new AdminController(svc as any, {} as any);
    await ctrl.callsByUser('30', 'meeting', 'talerid', '1', undefined, fakeRes());

    expect(svc.getCallsByUser).toHaveBeenCalledWith({
      days: 30, kind: 'meeting', provider: 'talerid', includeTest: true, limit: undefined,
    });
  });

  it('без includeTest тестовые не включаются', async () => {
    const svc = { getCallSessions: jest.fn().mockResolvedValue({}) };
    const ctrl = new AdminController(svc as any, {} as any);
    await ctrl.callSessions(undefined, undefined, undefined, undefined, undefined, fakeRes());

    expect(svc.getCallSessions).toHaveBeenCalledWith(expect.objectContaining({ includeTest: false }));
  });
});
