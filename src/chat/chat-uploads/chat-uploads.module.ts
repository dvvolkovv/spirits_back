import { Module, OnModuleInit } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { ChatUploadsController } from './chat-uploads.controller';
import { ChatUploadsService } from './chat-uploads.service';

/**
 * Реестр загруженных исходников живёт отдельным модулем: ChatModule его
 * импортирует, а ProfileModule сможет импортировать позже для очистки при
 * удалении аккаунта — без цикла DI (модуль не импортирует никого, кроме
 * общего CommonModule).
 *
 * Миграция применяется при старте (образец — alert-bot.lifecycle.ts): сбой
 * migrate() прокидывается наверх и не даёт приложению подняться без таблицы.
 */
@Module({
  imports: [CommonModule],
  controllers: [ChatUploadsController],
  providers: [ChatUploadsService],
  exports: [ChatUploadsService],
})
export class ChatUploadsModule implements OnModuleInit {
  constructor(private readonly uploads: ChatUploadsService) {}

  async onModuleInit(): Promise<void> {
    await this.uploads.migrate();
  }
}
