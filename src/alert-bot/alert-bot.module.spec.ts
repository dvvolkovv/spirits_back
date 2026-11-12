import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AdminModule } from '../admin/admin.module';
import { AdminService } from '../admin/admin.service';
import { AppModule } from '../app.module';
import { ChatModule } from '../chat/chat.module';
import { ChatService } from '../chat/chat.service';
import { CommonModule } from '../common/common.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { MonitoringService } from '../monitoring/monitoring.service';
import { SupportModule } from '../support/support.module';
import { SupportService } from '../support/support.service';
import { ALERT_BOT_HANDLER, ALERT_BOT_OPS_TOOLS } from './alert-bot.config';
import { AlertBotLifecycle } from './alert-bot.lifecycle';
import { AlertBotModule } from './alert-bot.module';
import { AlertBotOpsServer } from './alert-bot.ops-server';
import { AlertBotRepairAuth } from './alert-bot.repair-auth';
import { AlertBotRepairExecutor } from './alert-bot.repair-executor';
import { AlertBotRepairJobs } from './alert-bot.repair-jobs';
import { RepairStore } from './alert-bot.repair-store';
import { AlertBotRepairTools } from './alert-bot.repair-tools';
import { AlertBotService } from './alert-bot.service';
import { AlertBotStore } from './alert-bot.store';
import { AlertBotTools } from './alert-bot.tools';

describe('AlertBotModule: жизненный цикл и DI', () => {
  afterEach(() => jest.restoreAllMocks());

  it('импортирует только нужные соседние модули', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AlertBotModule);
    expect(imports).toEqual(expect.arrayContaining([
      CommonModule, ChatModule, SupportModule, MonitoringModule, AdminModule,
    ]));
  });

  it('AppModule подключает AlertBotModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(AlertBotModule);
  });

  it('регистрирует свои сервисы и не создаёт вторые экземпляры соседних', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AlertBotModule);
    expect(providers).toEqual(expect.arrayContaining([
      AlertBotService, AlertBotTools, AlertBotOpsServer, AlertBotLifecycle,
      RepairStore, AlertBotRepairExecutor, AlertBotRepairJobs, AlertBotRepairAuth, AlertBotRepairTools,
    ]));
    expect(providers).not.toContain(ChatService);
    expect(providers).not.toContain(SupportService);
    expect(providers).not.toContain(AdminService);
    expect(providers).not.toContain(MonitoringService);
  });

  it('handler и ops tools привязаны через useExisting', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AlertBotModule);
    expect(providers).toContainEqual({ provide: ALERT_BOT_HANDLER, useExisting: AlertBotService });
    expect(providers).toContainEqual({ provide: ALERT_BOT_OPS_TOOLS, useExisting: AlertBotTools });

    const injected = Reflect.getMetadata('self:paramtypes', AlertBotOpsServer) || [];
    expect(injected).toContainEqual({ index: 1, param: ALERT_BOT_OPS_TOOLS });
  });

  it('sync-api-keys-to-test не переносит настройки бота алертов', () => {
    const script = fs.readFileSync(path.join(__dirname, '../../scripts/sync-api-keys-to-test.sh'), 'utf8');
    expect(script).not.toContain('ALERT_BOT_');
    expect(script).not.toContain('ALERT_BOT_REPAIR_');
  });

  it('миграция лежит в src и store умеет fallback из dist в src с pg mock', async () => {
    const bundled = path.join(__dirname, 'migrations', '001_alert_bot.sql');
    const fallback = path.join(__dirname, '..', '..', 'src', 'alert-bot', 'migrations', '001_alert_bot.sql');
    expect(fs.existsSync(bundled)).toBe(true);
    const expectedSql = fs.readFileSync(fallback, 'utf8');
    const distBundled = bundled.replace(
      `${path.sep}src${path.sep}alert-bot${path.sep}`,
      `${path.sep}dist${path.sep}alert-bot${path.sep}`,
    );
    const originalJoin = path.join;
    jest.spyOn(path, 'join').mockImplementation((...parts: string[]) => {
      if (parts.length === 3 && parts[1] === 'migrations' && parts[2] === '001_alert_bot.sql') {
        return distBundled;
      }
      return originalJoin(...parts);
    });
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const exists = jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => String(candidate) === fallback);

    await new AlertBotStore({ query } as any).migrate();

    expect(exists).toHaveBeenNthCalledWith(1, distBundled);
    expect(exists).toHaveBeenNthCalledWith(2, fallback);
    expect(query).toHaveBeenCalledWith(expectedSql);
  });
});
