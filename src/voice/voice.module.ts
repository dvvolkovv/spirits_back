import { Module } from '@nestjs/common';
import { SpeechkitSttService } from './speechkit-stt.service';
import { TtsService } from './tts.service';
import { TtsController } from './tts.controller';
import { VoiceController } from './voice.controller';
import { VoiceImproveService } from './voice-improve.service';
import { MiscModule } from '../misc/misc.module';

/**
 * Голосовые операции: диктовка (SpeechKit STT через voice-ws) + TTS + «Улучшить» надиктованный текст
 * (пунктуация/падежи, opt-in внешний ИИ — [VoiceController]/[VoiceImproveService], 2026-08-23).
 */
@Module({
  imports: [MiscModule],
  controllers: [TtsController, VoiceController],
  providers: [SpeechkitSttService, TtsService, VoiceImproveService],
  exports: [SpeechkitSttService, TtsService],
})
export class VoiceModule {}
