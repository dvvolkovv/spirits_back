import { Module } from '@nestjs/common';
import { SpeechkitSttService } from './speechkit-stt.service';
import { TtsService } from './tts.service';
import { TtsController } from './tts.controller';
import { MiscModule } from '../misc/misc.module';

@Module({
  imports: [MiscModule],
  controllers: [TtsController],
  providers: [SpeechkitSttService, TtsService],
  exports: [SpeechkitSttService, TtsService],
})
export class VoiceModule {}
