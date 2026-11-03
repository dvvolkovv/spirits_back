import 'reflect-metadata';
import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { SupportModule } from './support.module';
import { SupportService } from './support.service';
import { TelegramNotifierService } from './telegram-notifier.service';
import { JwtService } from '../common/services/jwt.service';
import { PgService } from '../common/services/pg.service';

jest.setTimeout(60_000);

/**
 * АДРЕСА ПОДДЕРЖКИ — живым приложением Nest, а не метаданными маршрутов (как в
 * mcp.controller.routes.spec.ts). Контроллеры берутся из самого SupportModule:
 * новый контроллер в модуле попадает в проверку без правки спеки. Зависимости —
 * заглушки: проверяется маршрутизация, а не поддержка.
 *
 * Вебхука `support/telegram-hook` нет: Telegram в него не ходил (у бота алертов
 * не было вебхука), а сообщения боту принимает отдельная точка со своей
 * проверкой.
 */
const supportControllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SupportModule) ?? [];

@Module({
  controllers: supportControllers,
  providers: [
    { provide: SupportService, useValue: {} },
    { provide: TelegramNotifierService, useValue: {} },
    { provide: JwtService, useValue: { verify: () => { throw new Error('bad token'); } } },
    { provide: PgService, useValue: { query: async () => ({ rows: [] }) } },
  ],
})
class SupportRoutesSpecModule {}

describe('адреса поддержки', () => {
  let app: INestApplication;
  let port = 0;

  beforeAll(async () => {
    app = await NestFactory.create(SupportRoutesSpecModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('webhook');
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Запрос без keep-alive (agent: false): открытый сокет не держит jest. */
  function call(method: string, p: string, body?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = body ? { 'content-type': 'application/json' } : {};
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it('контроллеры модуля смонтированы: точка пользователя без токена — 401, а не 404', async () => {
    expect(await call('GET', '/webhook/support/health')).toBe(401);
  });

  it('вебхука support/telegram-hook нет — 404 на любой запрос', async () => {
    expect(await call('POST', '/webhook/support/telegram-hook', '{}')).toBe(404);
    expect(await call('POST', '/webhook/support/telegram-hook', JSON.stringify({ message: { text: '/status', chat: { id: 1 }, from: { id: 1 }, message_id: 1 } }))).toBe(404);
  });
});
