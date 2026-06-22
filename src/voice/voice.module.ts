import { Module } from '@nestjs/common';
import { SpeechkitSttService } from './speechkit-stt.service';

@Module({
  providers: [SpeechkitSttService],
  exports: [SpeechkitSttService],
})
export class VoiceModule {}
