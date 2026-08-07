// src/speech/speech.module.ts
import { Module } from '@nestjs/common';
import { SpeechService } from './speech.service';
import { SpeechController } from './speech.controller';
import { CommonModule } from '../common/common.module';

// PgService / StorageService / LanguageService / RedisService приходят из
// CommonModule (он @Global, импорт тут — для явности). MiscModule больше не
// нужен: списание идёт своим условным UPDATE в SpeechService, а не общим
// MiscService.deductTokens (тот безусловен и уводил баланс в минус на
// параллельных синтезах).
@Module({
  imports: [CommonModule],
  controllers: [SpeechController],
  providers: [SpeechService],
  exports: [SpeechService],
})
export class SpeechModule {}
