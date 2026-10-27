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
import { ShortsYoutubeController } from './shorts-youtube.controller';
import { ShortsYoutubeService } from './shorts-youtube.service';

/**
 * Короткие ролики (спека 2026-10-24-promo-shorts-design.md).
 *
 * Кольцо с TgBotModule (роликам — TgGrammyClient, боту — ShortsApprovalService
 * для кнопок) разорвано forwardRef с обеих сторон, как у BlogModule.
 * BlogRelayClient — свой экземпляр: класс без состояния, BlogModule его не
 * экспортирует. ScheduleModule не импортируется — он глобальный (app.module.ts).
 *
 * YouTube (спека 2026-10-27-shorts-youtube-autopublish-design.md): ShortsYoutubeService — боту для /youtube, публикатору для загрузки.
 */
@Module({
  imports: [CommonModule, AgentsModule, forwardRef(() => TgBotModule)],
  controllers: [ShortsController, ShortsYoutubeController],
  providers: [
    ShortsSchemaService,
    ShortsSettingsService,
    ShortsTopicService,
    BlogRelayClient,
    ShortsDirectorService,
    ShortsWriterService,
    ShortsApprovalService,
    ShortsYoutubeService,
    ShortsPublisherService,
    ShortsCron,
  ],
  exports: [ShortsApprovalService, ShortsYoutubeService],
})
export class ShortsModule {}
