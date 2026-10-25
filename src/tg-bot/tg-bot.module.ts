import { Module, forwardRef } from '@nestjs/common';
import { TgBotController } from './tg-bot.controller';
import { TgBotConfigController } from './tg-bot-config.controller';
import { TgBotService } from './tg-bot.service';
import { TgGrammyClient } from './tg-grammy.client';
import { TgIdentityService } from './tg-identity.service';
import { TgConfigService } from './tg-config.service';
import { TgClaimService } from './tg-claim.service';
import { TgRouterService } from './tg-router.service';
import { TgVoiceService } from './tg-voice.service';
import { TgBillingService } from './tg-billing.service';
import { TgCommandsService } from './tg-commands.service';
import { TgMeetingService } from './tg-meeting.service';
import { TgVideoDispatchService } from './tg-video-dispatch.service';
import { AgentsModule } from '../agents/agents.module';
import { CommonModule } from '../common/common.module';
import { MiscModule } from '../misc/misc.module';
import { VideoModule } from '../video/video.module';
import { MeetingModule } from '../meeting/meeting.module';
import { RoomModule } from '../meeting/room.module';
import { BlogModule } from '../blog/blog.module';
import { InsightsModule } from '../insights/insights.module';
import { CostGrowthService } from '../cost-growth/cost-growth.service';

@Module({
  // forwardRef на BlogModule — вторая половина разрыва кольца: блог берёт
  // отсюда TgGrammyClient, бот оттуда — BlogApprovalService.
  imports: [
    AgentsModule,
    CommonModule,
    MiscModule,
    VideoModule,
    MeetingModule,
    RoomModule,
    forwardRef(() => BlogModule),
    // Кнопки сводки «Затыки недели»: модуль сводки шлёт через TgGrammyClient,
    // а бот зовёт его обработчик — кольцо рвётся forwardRef с обеих сторон.
    forwardRef(() => InsightsModule),
  ],
  controllers: [TgBotController, TgBotConfigController],
  providers: [
    TgBotService, TgGrammyClient, TgIdentityService, TgConfigService,
    TgClaimService, TgRouterService, TgVoiceService, TgBillingService, TgCommandsService,
    TgVideoDispatchService, TgMeetingService, CostGrowthService,
  ],
  exports: [
    TgBotService, TgGrammyClient, TgIdentityService, TgConfigService,
    TgClaimService, TgRouterService, TgVoiceService, TgBillingService, TgCommandsService,
  ],
})
export class TgBotModule {}
