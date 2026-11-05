import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AlertBotAccess } from './alert-bot.access';
import { ALERT_BOT_OPS_TOOLS } from './alert-bot.config';
import { AlertBotOpsServer } from './alert-bot.ops-server';

@Module({
  providers: [
    AlertBotOpsServer,
    { provide: AlertBotAccess, useValue: { isAdminUserId: jest.fn() } },
    {
      provide: ALERT_BOT_OPS_TOOLS,
      useValue: { definitions: jest.fn(), execute: jest.fn() },
    },
  ],
})
class AlertBotOpsServerDiSpecModule {}

describe('AlertBotOpsServer: реальный Nest DI', () => {
  it('создаётся без провайдера options и закрывается без запуска HTTP-сервера', async () => {
    const app = await NestFactory.createApplicationContext(AlertBotOpsServerDiSpecModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const server = app.get(AlertBotOpsServer);
      expect(server).toBeInstanceOf(AlertBotOpsServer);
      expect((server as any).server).toBeNull();
    } finally {
      await app.close();
    }
  });
});
