import { Module } from '@nestjs/common';
import { AskController } from './ask.controller';
import { CleanAskService } from './clean-ask.service';

/** «Поговорить начисто»: де-связанный запрос в облачный LLM (без профиля/истории/аккаунта). */
@Module({
  controllers: [AskController],
  providers: [CleanAskService],
})
export class AskModule {}
