import { Module } from '@nestjs/common';
import { TgBotController } from './tg-bot.controller';
import { TgBotService } from './tg-bot.service';
import { TgGrammyClient } from './tg-grammy.client';

@Module({
  controllers: [TgBotController],
  providers: [TgBotService, TgGrammyClient],
  exports: [TgBotService, TgGrammyClient],
})
export class TgBotModule {}
