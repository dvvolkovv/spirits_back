import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { BlogRelayClient } from '../blog/blog-relay.client';
import { CommonModule } from '../common/common.module';
import { TgBotModule } from '../tg-bot/tg-bot.module';
import { ShortsApprovalService } from './shorts-approval.service';
import { ShortsDirectorService } from './shorts-director.service';
import { ShortsPublisherService } from './shorts-publisher.service';
import { ShortsSchemaService } from './shorts-schema.service';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortsTopicService } from './shorts-topic.service';
import { ShortsWriterService } from './shorts-writer.service';
import { ShortsController } from './shorts.controller';
import { ShortsCron } from './shorts.cron';

/**
 * Короткие ролики (спека 2026-10-24-promo-shorts-design.md).
 *
 * Кольцо с TgBotModule (роликам — TgGrammyClient, боту — ShortsApprovalService
 * для кнопок) разорвано forwardRef с обеих сторон, как у BlogModule.
 * BlogRelayClient — свой экземпляр: класс без состояния, BlogModule его не
 * экспортирует. ScheduleModule не импортируется — он глобальный (app.module.ts).
 */
@Module({
  imports: [CommonModule, AgentsModule, forwardRef(() => TgBotModule)],
  controllers: [ShortsController],
  providers: [
    ShortsSchemaService,
    ShortsSettingsService,
    ShortsTopicService,
    BlogRelayClient,
    ShortsDirectorService,
    ShortsWriterService,
    ShortsApprovalService,
    ShortsPublisherService,
    ShortsCron,
  ],
  exports: [ShortsApprovalService],
})
export class ShortsModule {}
