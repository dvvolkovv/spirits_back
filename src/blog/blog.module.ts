import { Module, forwardRef } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { MiscModule } from '../misc/misc.module';
import { TgBotModule } from '../tg-bot/tg-bot.module';
import { BlogController } from './blog.controller';
import { BlogSettingsService } from './blog-settings.service';
import { BlogTopicService } from './blog-topic.service';
import { BlogGitSource } from './blog-git.source';
import { BlogNewsService } from './blog-news.service';
import { BlogRelayClient } from './blog-relay.client';
import { BlogEditorService } from './blog-editor.service';
import { BlogImageService } from './blog-image.service';
import { BlogPublisherService } from './blog-publisher.service';
import { BlogApprovalService } from './blog-approval.service';
import { BlogCron } from './blog.cron';

/**
 * Полная сборка модуля блога.
 *
 * Кольцо BlogModule ↔ TgBotModule (блогу нужен TgGrammyClient для публикации
 * и апрува, боту — BlogApprovalService для кнопок под черновиком) разорвано
 * forwardRef с обеих сторон. Снимешь forwardRef здесь или там — Nest не
 * соберёт граф и приложение не поднимется.
 *
 * MiscModule — ради MiscService: генерация картинки к посту идёт через него.
 *
 * ScheduleModule здесь намеренно НЕ импортируется: `ScheduleModule.forRoot()`
 * подключён глобально в app.module.ts и через DiscoveryService обходит
 * провайдеры всего приложения, так что @Cron в BlogCron заводится сам. Это
 * принятый в проекте способ — SchedulerModule со своими четырьмя кронами
 * тоже ничего не импортирует.
 */
@Module({
  imports: [CommonModule, MiscModule, forwardRef(() => TgBotModule)],
  controllers: [BlogController],
  providers: [
    BlogSettingsService,
    BlogTopicService,
    BlogGitSource,
    BlogNewsService,
    BlogRelayClient,
    BlogEditorService,
    BlogImageService,
    BlogPublisherService,
    BlogApprovalService,
    BlogCron,
  ],
  exports: [BlogApprovalService],
})
export class BlogModule {}
