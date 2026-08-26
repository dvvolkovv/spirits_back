import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ChatModule } from '../chat/chat.module';
import { VoiceCallController } from './voice-call.controller';
import { VoiceCallInternalController } from './voice-call-internal.controller';
import { VoiceCallStatusController } from './voice-call-status.controller';
import { VoiceCallService } from './voice-call.service';
import { SpecialistJobService } from './specialist-job.service';
import { VoiceDocumentService } from './voice-document.service';
import { LiveKitClient } from './livekit.client';
import { VoiceCallReaperService } from './voice-call-reaper.service';

/**
 * VOICE_CALLBACK_SECRET читается ТОЛЬКО во время запроса, в контроллере.
 *
 * Читать его на уровне модуля нельзя: `process.env` наполняется из `.env`
 * через `ConfigModule.forRoot()` в app.module, а тот отрабатывает ПОЗЖЕ, чем
 * вычисляются module-level константы импортированных модулей. Константа
 * всегда оказывалась бы false, и внутренние ручки не регистрировались бы
 * даже при заданном секрете — то есть фича молча не работала бы в проде.
 * В репозитории про эти грабли уже есть три предупреждения, см.
 * claude-health.service.ts:86 и соседей.
 *
 * Поэтому контроллер регистрируется всегда, а без секрета его ручки отвечают
 * 503: недоступны, но и не открыты. Проверка в onModuleInit ниже — только
 * диагностика в лог, она отрабатывает уже после ConfigModule.
 */
@Module({
  imports: [CommonModule, ChatModule],
  controllers: [VoiceCallController, VoiceCallInternalController, VoiceCallStatusController],
  providers: [VoiceCallService, SpecialistJobService, VoiceDocumentService, LiveKitClient, VoiceCallReaperService],
  exports: [VoiceCallService],
})
export class VoiceCallModule implements OnModuleInit {
  private readonly logger = new Logger(VoiceCallModule.name);

  onModuleInit(): void {
    if (!process.env.VOICE_CALLBACK_SECRET) {
      this.logger.error(
        'VOICE_CALLBACK_SECRET не задан — /webhook/voice-call/internal/* отвечает 503. ' +
        'Приложение поднято, но звонки работать не будут: воркеру некуда слать ask/complete/failed.',
      );
    }
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      this.logger.warn('LIVEKIT_API_KEY/SECRET не заданы — звонки работать не будут');
    }
  }
}
