import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ChatModule } from '../chat/chat.module';
import { CommonModule } from '../common/common.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { SupportModule } from '../support/support.module';
import { AlertBotAccess } from './alert-bot.access';
import { AlertBotAi } from './alert-bot.ai';
import { AlertBotCommands } from './alert-bot.commands';
import { ALERT_BOT_HANDLER, ALERT_BOT_OPS_TOOLS } from './alert-bot.config';
import { AlertBotController } from './alert-bot.controller';
import { AlertBotDrafts } from './alert-bot.drafts';
import { AlertBotHealthService } from './alert-bot.health';
import { AlertBotLifecycle } from './alert-bot.lifecycle';
import { AlertBotOpsServer } from './alert-bot.ops-server';
import { AlertBotRepairAuth } from './alert-bot.repair-auth';
import { AlertBotRepairExecutor } from './alert-bot.repair-executor';
import { AlertBotRepairJobs } from './alert-bot.repair-jobs';
import { RepairStore } from './alert-bot.repair-store';
import { AlertBotRepairTools } from './alert-bot.repair-tools';
import { AlertBotService } from './alert-bot.service';
import { AlertBotStatusService } from './alert-bot.status';
import { AlertBotStore } from './alert-bot.store';
import { AlertBotTelegram } from './alert-bot.telegram';
import { AlertBotTools } from './alert-bot.tools';
import { AlertBotTurns } from './alert-bot.turns';

@Module({
  imports: [CommonModule, ChatModule, SupportModule, MonitoringModule, AdminModule],
  controllers: [AlertBotController],
  providers: [
    AlertBotAccess, AlertBotTelegram, AlertBotStore, AlertBotHealthService,
    AlertBotStatusService, AlertBotCommands, AlertBotDrafts, AlertBotTools,
    RepairStore, AlertBotRepairExecutor, AlertBotRepairJobs, AlertBotRepairAuth, AlertBotRepairTools,
    AlertBotOpsServer, AlertBotAi, AlertBotTurns, AlertBotService, AlertBotLifecycle,
    { provide: ALERT_BOT_HANDLER, useExisting: AlertBotService },
    { provide: ALERT_BOT_OPS_TOOLS, useExisting: AlertBotTools },
  ],
})
export class AlertBotModule {}
