// src/speech/speech.module.ts
import { Module } from '@nestjs/common';
import { SpeechService } from './speech.service';
import { SpeechController } from './speech.controller';
import { CommonModule } from '../common/common.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { SpeechAccountDeletionAdapter } from './speech-account-deletion.adapter';

// PgService / StorageService / LanguageService / RedisService приходят из
// CommonModule (он @Global, импорт тут — для явности). MiscModule больше не
// нужен: списание идёт своим условным UPDATE в SpeechService, а не общим
// MiscService.deductTokens (тот безусловен и уводил баланс в минус на
// параллельных синтезах).
@Module({
  imports: [CommonModule, AccountDeletionModule],
  controllers: [SpeechController],
  providers: [SpeechService, SpeechAccountDeletionAdapter],
  exports: [SpeechService],
})
export class SpeechModule {}
