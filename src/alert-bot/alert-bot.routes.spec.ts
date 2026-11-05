import 'reflect-metadata';
import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ALERT_BOT_HANDLER } from './alert-bot.config';
import { AlertBotController } from './alert-bot.controller';

const handler = {
  claimUpdate: jest.fn<Promise<boolean>, [unknown]>(),
  handleUpdate: jest.fn<Promise<void>, [unknown, boolean]>(),
};

@Module({
  controllers: [AlertBotController],
  providers: [{ provide: ALERT_BOT_HANDLER, useValue: handler }],
})
class AlertBotRoutesSpecModule {}

describe('публичные маршруты бота алертов', () => {
  const oldUrl = process.env.ALERT_BOT_WEBHOOK_URL;
  const oldSecret = process.env.ALERT_BOT_WEBHOOK_SECRET;
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    process.env.ALERT_BOT_WEBHOOK_URL = 'https://example.test/webhook/alert-bot/telegram';
    process.env.ALERT_BOT_WEBHOOK_SECRET = 'routes-secret';
    handler.claimUpdate.mockResolvedValue(true);
    handler.handleUpdate.mockResolvedValue(undefined);
    app = await NestFactory.create(AlertBotRoutesSpecModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('webhook');
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
    if (oldUrl === undefined) delete process.env.ALERT_BOT_WEBHOOK_URL;
    else process.env.ALERT_BOT_WEBHOOK_URL = oldUrl;
    if (oldSecret === undefined) delete process.env.ALERT_BOT_WEBHOOK_SECRET;
    else process.env.ALERT_BOT_WEBHOOK_SECRET = oldSecret;
  });

  beforeEach(() => {
    handler.claimUpdate.mockClear();
    handler.handleUpdate.mockClear();
  });

  function post(path: string, secret: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path, method: 'POST', agent: false,
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': secret,
        },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ update_id: 12 }));
    });
  }

  it('верный secret открывает только telegram webhook', async () => {
    await expect(post('/webhook/alert-bot/telegram', 'routes-secret')).resolves.toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handler.claimUpdate).toHaveBeenCalledWith({ update_id: 12 });
    expect(handler.handleUpdate).toHaveBeenCalledWith({ update_id: 12 }, true);
  });

  it('ops MCP не опубликован через Nest', async () => {
    await expect(post('/webhook/mcp/ops', 'routes-secret')).resolves.toBe(404);
    expect(handler.claimUpdate).not.toHaveBeenCalled();
    expect(handler.handleUpdate).not.toHaveBeenCalled();
  });
});
