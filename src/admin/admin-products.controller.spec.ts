/**
 * Раздел «Сайты и боты»: адреса маршрутов, проводка фильтров и охрана.
 *
 * Фильтры разбирает сервис, но только те, что до него доехали: забытый здесь
 * includeArchived молча прятал бы архив навсегда. Метаданные гвардов обходит
 * common/guards/admin-routes.spec.ts; здесь — то, чего метаданные не видят:
 * гварды на настоящем маршрутизаторе Nest действительно отбивают
 * не-администратора (403), а контроллер зарегистрирован в модуле — маршруты
 * незарегистрированного контроллера отдают 404 при зелёных юнит-тестах.
 */
import 'reflect-metadata';
import * as http from 'http';
import { INestApplication, Module, NotFoundException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { AdminProductsController } from './admin-products.controller';
import { AdminProductsService } from './admin-products.service';
import { AdminModule } from './admin.module';
import { PgService } from '../common/services/pg.service';
import { JwtService } from '../common/services/jwt.service';

const ID = '3f2b9c1e-8a4d-4e6f-9b0a-1c2d3e4f5a6b';

/** Ключи query-параметров, которые маршрут читает через @Query('…'). */
function queryNamesOf(method: string): string[] {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminProductsController, method) ?? {};
  return Object.keys(args)
    .filter((k) => k.startsWith(`${RouteParamtypes.QUERY}:`))
    .map((k) => args[k].data)
    .sort();
}

/**
 * Вызвать маршрут так, как это делает Nest: аргументы — по именам из
 * @Query('…') и @Param('…'), а не по позиции. Позиционный вызов не заметил бы
 * опечатки в имени ключа.
 */
function viaRoute(
  ctrl: any,
  method: string,
  query: Record<string, any>,
  params: Record<string, string> = {},
) {
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminProductsController, method) ?? {};
  const args: unknown[] = [];
  for (const [key, { index, data }] of Object.entries<any>(meta)) {
    const type = Number(key.split(':')[0]);
    if (type === RouteParamtypes.QUERY) args[index] = query[data];
    if (type === RouteParamtypes.PARAM) args[index] = params[data];
  }
  return ctrl[method](...args);
}

describe('AdminProductsController: адреса', () => {
  it('список — GET admin/products, карточка — GET admin/products/:id', () => {
    const route = (m: string) => {
      const h = (AdminProductsController.prototype as any)[m];
      return `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, h)]} ${Reflect.getMetadata(PATH_METADATA, h)}`;
    };
    expect(Reflect.getMetadata(PATH_METADATA, AdminProductsController)).toBe('');
    expect(route('listProducts')).toBe('GET admin/products');
    expect(route('productCard')).toBe('GET admin/products/:id');
  });

  it('контроллер и сервис зарегистрированы в AdminModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminModule)).toContain(AdminProductsController);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminModule)).toContain(AdminProductsService);
  });
});

describe('AdminProductsController: проводка фильтров', () => {
  it('список читает ровно эти query-ключи', () => {
    expect(queryNamesOf('listProducts')).toEqual(
      ['includeArchived', 'includeTest', 'kind', 'periodDays', 'q', 'status'].sort(),
    );
  });

  it('список передаёт в сервис все фильтры', async () => {
    const svc = { list: jest.fn().mockResolvedValue({ periodDays: 90, products: [] }) };
    const ctrl = new AdminProductsController(svc as any);
    const out = await viaRoute(ctrl, 'listProducts', {
      q: 'цветы',
      status: 'running,sleeping',
      kind: 'site',
      periodDays: '90',
      includeTest: '1',
      includeArchived: 'true',
    });

    expect(svc.list).toHaveBeenCalledWith({
      q: 'цветы',
      status: 'running,sleeping',
      kind: 'site',
      periodDays: 90,
      includeTest: true,
      includeArchived: true,
    });
    expect(out).toEqual({ periodDays: 90, products: [] });
  });

  it('флаги — только явное «да»; без периода сервис берёт своё умолчание', async () => {
    const svc = { list: jest.fn().mockResolvedValue({ periodDays: 30, products: [] }) };
    const ctrl = new AdminProductsController(svc as any);
    await viaRoute(ctrl, 'listProducts', { includeTest: 'yes', includeArchived: '0' });

    expect(svc.list).toHaveBeenCalledWith(
      expect.objectContaining({ periodDays: undefined, includeTest: false, includeArchived: false }),
    );
  });

  it('карточка читает период и передаёт его сервису', async () => {
    const card = { product: { id: ID }, domain: null, turns: [], jobs: [] };
    const svc = { card: jest.fn().mockResolvedValue(card) };
    const ctrl = new AdminProductsController(svc as any);

    expect(await viaRoute(ctrl, 'productCard', { periodDays: '7' }, { id: ID })).toBe(card);
    expect(svc.card).toHaveBeenCalledWith(ID, { periodDays: 7 });
  });
});

describe('AdminProductsController: карточка', () => {
  it('не-uuid — 404 до обращения к сервису', async () => {
    const svc = { card: jest.fn() };
    const ctrl = new AdminProductsController(svc as any);

    await expect(viaRoute(ctrl, 'productCard', {}, { id: 'shop' })).rejects.toBeInstanceOf(NotFoundException);
    expect(svc.card).not.toHaveBeenCalled();
  });

  it('неизвестный продукт — 404 с той же формулировкой, что у не-uuid', async () => {
    const svc = { card: jest.fn().mockResolvedValue(null) };
    const ctrl = new AdminProductsController(svc as any);

    const unknown = await viaRoute(ctrl, 'productCard', {}, { id: ID }).catch((e: any) => e);
    const garbage = await viaRoute(ctrl, 'productCard', {}, { id: 'x' }).catch((e: any) => e);
    expect(unknown).toBeInstanceOf(NotFoundException);
    expect(unknown.message).toBe(garbage.message);
  });
});

/** GET без keep-alive: иначе app.close() ждал бы открытое соединение. */
function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
  });
}

describe('AdminProductsController: охрана на настоящем маршрутизаторе Nest', () => {
  const ADMIN = '79030169187';
  const PLAIN = '79161234567';
  const LIST = { periodDays: 30, products: [] as any[] };

  let app: INestApplication;
  let base: string;
  const svc = { list: jest.fn(), card: jest.fn() };
  const jwt = new JwtService();
  const bearer = (userId: string) => ({ authorization: `Bearer ${jwt.signAccess(userId)}` });

  beforeAll(async () => {
    // Настоящие JwtGuard, AdminGuard и JwtService; подменены только база
    // (isadmin — по списку) и сервис раздела.
    const pg = {
      query: async (_sql: string, params?: any[]) => ({ rows: [{ isadmin: params?.[0] === ADMIN }] }),
    };

    @Module({
      controllers: [AdminProductsController],
      providers: [
        { provide: AdminProductsService, useValue: svc },
        { provide: PgService, useValue: pg },
        JwtService,
      ],
    })
    class GuardedModule {}

    app = await NestFactory.create(GuardedModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('webhook');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/webhook`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    svc.list.mockReset().mockResolvedValue(LIST);
    svc.card.mockReset().mockResolvedValue(null);
  });

  it('без токена — 401', async () => {
    expect((await get(`${base}/admin/products`)).status).toBe(401);
    expect(svc.list).not.toHaveBeenCalled();
  });

  it('не-администратор получает 403 на списке и на карточке, сервис не вызывается', async () => {
    expect((await get(`${base}/admin/products`, bearer(PLAIN))).status).toBe(403);
    expect((await get(`${base}/admin/products/${ID}`, bearer(PLAIN))).status).toBe(403);
    expect(svc.list).not.toHaveBeenCalled();
    expect(svc.card).not.toHaveBeenCalled();
  });

  it('администратор получает список, фильтры доезжают из строки запроса', async () => {
    const res = await get(`${base}/admin/products?q=%D1%86%D0%B2%D0%B5%D1%82&kind=bot&periodDays=7&includeArchived=1`, bearer(ADMIN));

    expect(res).toEqual({ status: 200, body: LIST });
    expect(svc.list).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'цвет', kind: 'bot', periodDays: 7, includeArchived: true, includeTest: false }),
    );
  });

  it('администратор получает карточку, период доезжает из строки запроса', async () => {
    const card = { periodDays: 7, product: { id: ID }, domain: null, turns: [], jobs: [] };
    svc.card.mockResolvedValue(card);

    const res = await get(`${base}/admin/products/${ID}?periodDays=7`, bearer(ADMIN));

    expect(res).toEqual({ status: 200, body: card });
    expect(svc.card).toHaveBeenCalledWith(ID, { periodDays: 7 });
  });

  it('администратор: не-uuid и неизвестный продукт — 404', async () => {
    expect((await get(`${base}/admin/products/shop`, bearer(ADMIN))).status).toBe(404);
    expect((await get(`${base}/admin/products/${ID}`, bearer(ADMIN))).status).toBe(404);
  });
});
