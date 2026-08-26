import { Module } from '@nestjs/common';
import { AskController } from './ask.controller';
import { CleanAskService } from './clean-ask.service';
import { AgentsModule } from '../agents/agents.module';

/** «Поговорить начисто»: де-связанный запрос в облачный LLM (без профиля/истории/аккаунта).
 *  AgentsModule — для персоны выбранного персонажа (Ф3); профиль остаётся телефон-де-ид. */
@Module({
  imports: [AgentsModule],
  controllers: [AskController],
  providers: [CleanAskService],
})
export class AskModule {}
