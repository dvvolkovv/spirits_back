// src/speech/speech.module.ts
import { Module } from '@nestjs/common';
import { SpeechService } from './speech.service';
import { SpeechController } from './speech.controller';
import { CommonModule } from '../common/common.module';
import { MiscModule } from '../misc/misc.module';

// PgService / StorageService / LanguageService / RedisService приходят из
// CommonModule (он @Global, импорт тут — для явности), MiscService —
// из MiscModule, он не глобальный.
@Module({
  imports: [CommonModule, MiscModule],
  controllers: [SpeechController],
  providers: [SpeechService],
  exports: [SpeechService],
})
export class SpeechModule {}
