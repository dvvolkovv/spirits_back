import { Module, forwardRef } from '@nestjs/common';
import { BacklogModule } from '../backlog/backlog.module';
import { TgBotModule } from '../tg-bot/tg-bot.module';
import { InsightsCallbackService } from './insights-callback.service';
import { InsightsCollectService } from './insights-collect.service';
import { InsightsController } from './insights.controller';
import { InsightsCron } from './insights.cron';
import { InsightsService } from './insights.service';
import { InsightsStore } from './insights-store.service';

/**
 * Затыки недели. TgBotModule — через forwardRef с обеих сторон: бот зовёт
 * InsightsCallbackService (кнопки сводки), а сводка шлётся через TgGrammyClient.
 */
@Module({
  imports: [BacklogModule, forwardRef(() => TgBotModule)],
  controllers: [InsightsController],
  providers: [InsightsStore, InsightsCollectService, InsightsService, InsightsCron, InsightsCallbackService],
  exports: [InsightsCallbackService],
})
export class InsightsModule {}
