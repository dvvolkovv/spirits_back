import { Module } from '@nestjs/common';
import { AskController } from './ask.controller';
import { FirstContactController } from './first-contact.controller';
import { CleanAskService } from './clean-ask.service';
import { AgentsModule } from '../agents/agents.module';
import { CommonModule } from '../common/common.module';

/** «Поговорить начисто»: де-связанный запрос в облачный LLM (без профиля/истории/аккаунта).
 *  AgentsModule — для персоны выбранного персонажа (Ф3); профиль остаётся телефон-де-ид.
 *  CommonModule — IpRateLimiter для публичного /webhook/first-contact (знакомство до входа). */
@Module({
  imports: [AgentsModule, CommonModule],
  controllers: [AskController, FirstContactController],
  providers: [CleanAskService],
})
export class AskModule {}
