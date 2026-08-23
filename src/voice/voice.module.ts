import { Module } from '@nestjs/common';
import { VoiceController } from './voice.controller';
import { VoiceImproveService } from './voice-improve.service';

/** Голосовые операции: «Улучшить» надиктованный текст (пунктуация/падежи) — opt-in, внешний ИИ. */
@Module({
  controllers: [VoiceController],
  providers: [VoiceImproveService],
})
export class VoiceModule {}
