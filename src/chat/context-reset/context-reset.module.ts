import { Module, OnModuleInit } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { ChatContextResetService } from './context-reset.service';

/**
 * Отдельный модуль, а не провайдер ChatModule: точку читают и голосовой звонок
 * (VoiceCallModule), и сборщик контекста (ContextModule) — без цикла через
 * ChatModule. Миграция при старте: без таблицы приложение не поднимается
 * (образец — ChatUploadsModule).
 */
@Module({
  imports: [CommonModule],
  providers: [ChatContextResetService],
  exports: [ChatContextResetService],
})
export class ContextResetModule implements OnModuleInit {
  constructor(private readonly resets: ChatContextResetService) {}

  async onModuleInit(): Promise<void> {
    await this.resets.migrate();
  }
}
