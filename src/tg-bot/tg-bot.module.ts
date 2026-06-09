import { Module } from '@nestjs/common';
import { TgBotController } from './tg-bot.controller';
import { TgBotConfigController } from './tg-bot-config.controller';
import { TgBotService } from './tg-bot.service';
import { TgGrammyClient } from './tg-grammy.client';
import { TgIdentityService } from './tg-identity.service';

@Module({
  controllers: [TgBotController, TgBotConfigController],
  providers: [TgBotService, TgGrammyClient, TgIdentityService],
  exports: [TgBotService, TgGrammyClient, TgIdentityService],
})
export class TgBotModule {}
