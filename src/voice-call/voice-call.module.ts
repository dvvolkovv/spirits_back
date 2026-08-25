import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ChatModule } from '../chat/chat.module';
import { VoiceCallController } from './voice-call.controller';
import { VoiceCallInternalController } from './voice-call-internal.controller';
import { VoiceCallService } from './voice-call.service';
import { SpecialistJobService } from './specialist-job.service';
import { LiveKitClient } from './livekit.client';

/**
 * Есть ли секрет для HMAC внутренних ручек. Читаем один раз при загрузке
 * модуля (= при старте процесса, env на это время уже статичен), а не в
 * onModuleInit — потому что от этого флага зависит СОСТАВ `controllers`,
 * а не только поведение внутри уже собранного модуля.
 */
const HAS_VOICE_SECRET = Boolean(process.env.VOICE_CALLBACK_SECRET);

/**
 * VOICE_CALLBACK_SECRET сейчас не задан ни на проде, ни на тесте. Бросить
 * исключение в onModuleInit (что сделал бы «честный» гард) уронило бы старт
 * ВСЕГО приложения — эта ручка не единственная в модуле.
 *
 * Поэтому вместо fail-fast на весь процесс — деградация одного модуля:
 * без секрета VoiceCallInternalController просто не регистрируется, и
 * `/webhook/voice-call/internal/*` отвечает обычным 404 (роута нет), а не
 * 401/500 из-за попытки HMAC со `secret=undefined`. Публичный
 * VoiceCallController (start/end/get, за JwtGuard) при этом продолжает
 * работать — это отдельная поверхность, HMAC её не касается.
 */
@Module({
  imports: [CommonModule, ChatModule],
  controllers: [VoiceCallController, ...(HAS_VOICE_SECRET ? [VoiceCallInternalController] : [])],
  providers: [VoiceCallService, SpecialistJobService, LiveKitClient],
  exports: [VoiceCallService],
})
export class VoiceCallModule implements OnModuleInit {
  private readonly logger = new Logger(VoiceCallModule.name);

  onModuleInit(): void {
    if (!HAS_VOICE_SECRET) {
      this.logger.error(
        'VOICE_CALLBACK_SECRET не задан — VoiceCallInternalController отключён ' +
        '(/webhook/voice-call/internal/* отвечает 404). Приложение поднято, но звонки ' +
        'работать не будут: воркеру некуда слать ask/complete/failed.',
      );
    }
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      this.logger.warn('LIVEKIT_API_KEY/SECRET не заданы — звонки работать не будут');
    }
  }
}
