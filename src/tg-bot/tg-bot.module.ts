import { Module } from '@nestjs/common';
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
import { AgentsModule } from '../agents/agents.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [AgentsModule, CommonModule],
  controllers: [TgBotController, TgBotConfigController],
  providers: [
    TgBotService, TgGrammyClient, TgIdentityService, TgConfigService,
    TgClaimService, TgRouterService, TgVoiceService, TgBillingService,
  ],
  exports: [
    TgBotService, TgGrammyClient, TgIdentityService, TgConfigService,
    TgClaimService, TgRouterService, TgVoiceService, TgBillingService,
  ],
})
export class TgBotModule {}
