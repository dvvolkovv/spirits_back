import 'reflect-metadata';
import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AlertBotController } from './alert-bot.controller';
import { ALERT_BOT_HANDLER } from './alert-bot.config';

const handler = { handleUpdate: jest.fn<Promise<void>, [unknown]>() };

@Module({
  controllers: [AlertBotController],
  providers: [{ provide: ALERT_BOT_HANDLER, useValue: handler }],
})
class AlertBotControllerSpecModule {}

describe('защищённый webhook бота алертов', () => {
  const originalEnv = { ...process.env };
  let app: INestApplication;
  let port = 0;
  let loggerError: jest.SpyInstance;

  beforeEach(async () => {
    process.env.ALERT_BOT_WEBHOOK_URL = 'https://example.test/webhook/alert-bot/telegram';
    process.env.ALERT_BOT_WEBHOOK_SECRET = 'secret';
    handler.handleUpdate.mockReset();
    app = await NestFactory.create(AlertBotControllerSpecModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('webhook');
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
    const controller = app.get(AlertBotController);
    loggerError = jest.spyOn((controller as any).logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await app?.close();
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  function post(update: unknown, secret?: string): Promise<{ status: number; body: string }> {
    const body = JSON.stringify(update);
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (secret !== undefined) headers['x-telegram-bot-api-secret-token'] = secret;
      const req = http.request({ host: '127.0.0.1', port, path: '/webhook/alert-bot/telegram', method: 'POST', headers, agent: false }, (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  it('без настроенных URL и секрета отвечает 404', async () => {
    delete process.env.ALERT_BOT_WEBHOOK_URL;
    delete process.env.ALERT_BOT_WEBHOOK_SECRET;
    expect((await post({ update_id: 1 }, 'secret')).status).toBe(404);
    expect(handler.handleUpdate).not.toHaveBeenCalled();
  });

  it('с неверным секретом отвечает 401', async () => {
    expect((await post({ update_id: 2 }, 'wrong')).status).toBe(401);
    expect(handler.handleUpdate).not.toHaveBeenCalled();
  });

  it('с верным секретом отвечает 200 и передаёт update обработчику после setImmediate', async () => {
    const update = { update_id: 3, message: { text: 'привет' } };
    expect((await post(update, 'secret')).status).toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handler.handleUpdate).toHaveBeenCalledWith(update);
  });

  it('ошибка обработчика не меняет 200 и не попадает в журнал вместе с update', async () => {
    handler.handleUpdate.mockRejectedValue(new Error('СЕКРЕТ-ИЗ-ОТВЕТА'));
    const update = { update_id: 4, message: { text: 'СЕКРЕТ-ИЗ-UPDATE' } };
    expect((await post(update, 'secret')).status).toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const logs = loggerError.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logs).not.toContain('СЕКРЕТ-ИЗ-ОТВЕТА');
    expect(logs).not.toContain(JSON.stringify(update));
  });
});
