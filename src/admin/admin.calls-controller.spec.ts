import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
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

/** Ключи query-параметров, которые маршрут читает через @Query('…'). */
function queryNamesOf(method: string): string[] {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminController, method) ?? {};
  return Object.keys(args)
    .filter((k) => k.startsWith(`${RouteParamtypes.QUERY}:`))
    .map((k) => args[k].data)
    .sort();
}

/**
 * Вызвать маршрут так, как это делает Nest: аргументы берутся по именам из
 * @Query('…'), а не по позиции. Позиционный вызов не заметил бы опечатки в
 * имени ключа — а includeTest в запросе и include_test в ответе здесь рядом.
 */
function viaRoute(ctrl: any, method: string, query: Record<string, string | undefined>, res: any) {
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminController, method) ?? {};
  const args: unknown[] = [];
  for (const [key, { index, data }] of Object.entries<any>(meta)) {
    const type = Number(key.split(':')[0]);
    if (type === RouteParamtypes.QUERY) args[index] = query[data];
    if (type === RouteParamtypes.RESPONSE) args[index] = res;
  }
  return ctrl[method](...args);
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
    await viaRoute(ctrl, 'callSessions', { days: '90', kind: 'meeting', provider: 'zoom', includeTest: '1', limit: '100' }, res);

    expect(svc.getCallSessions).toHaveBeenCalledWith({
      days: 90, kind: 'meeting', provider: 'zoom', includeTest: true, limit: 100,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
  });

  it('таблица принимает площадку и тестовые', async () => {
    const svc = { getCallsByUser: jest.fn().mockResolvedValue({}) };
    const ctrl = new AdminController(svc as any, {} as any);
    await viaRoute(ctrl, 'callsByUser', { days: '30', kind: 'meeting', provider: 'talerid', includeTest: '1' }, fakeRes());

    expect(svc.getCallsByUser).toHaveBeenCalledWith({
      days: 30, kind: 'meeting', provider: 'talerid', includeTest: true, limit: undefined,
    });
  });

  it('без includeTest тестовые не включаются', async () => {
    const svc = { getCallSessions: jest.fn().mockResolvedValue({}) };
    const ctrl = new AdminController(svc as any, {} as any);
    await viaRoute(ctrl, 'callSessions', {}, fakeRes());

    expect(svc.getCallSessions).toHaveBeenCalledWith(expect.objectContaining({ includeTest: false }));
  });

  it('таблица и лента читают одни и те же query-параметры', () => {
    // Обе ручки — один набор фильтров раздела: параметр, добавленный в одну
    // и забытый в другой, развёл бы таблицу и ленту.
    expect(queryNamesOf('callSessions')).toEqual(['days', 'includeTest', 'kind', 'limit', 'provider']);
    expect(queryNamesOf('callsByUser')).toEqual(queryNamesOf('callSessions'));
  });
});
