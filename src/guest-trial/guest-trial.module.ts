// src/guest-trial/guest-trial.module.ts
import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { GuestTrialController } from './guest-trial.controller';
import { GuestTrialStore } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { GuestTurnService } from './guest-turn.service';
import { GuestClaimService } from './guest-claim.service';
import { GuestTrialCron } from './guest-trial.cron';
import { GuestAccountDeletionAdapter } from './guest-account-deletion.adapter';

/**
 * Проба ассистента без регистрации. ChatModule — ради ChatService.beginStream/
 * endStream: deploy.sh перед рестартом ждёт и гостевые ходы. Pg, Redis, CLI и
 * события — из глобальных модулей. Neo4j этому модулю с 31.10.2026 не нужен
 * вовсе: перенос пробы в аккаунт не дополняет профиль ценностей (решение
 * владельца — общий компьютер, см. guest-claim.service.ts).
 */
@Module({
  imports: [ChatModule, AccountDeletionModule],
  controllers: [GuestTrialController],
  providers: [GuestTrialStore, GuestSessionsService, GuestTurnService, GuestClaimService, GuestTrialCron, GuestAccountDeletionAdapter],
})
export class GuestTrialModule {}
