import { Module } from '@nestjs/common';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { ChatModule } from '../chat/chat.module';
import { RoutineAccountDeletionAdapter } from './routine-account-deletion.adapter';
import { RoutinePushService } from './routine-push.service';
import { RoutinePushController } from './routine-push.controller';

// Слой 3: проактивные рутинные пуши. Тянет ChatService (генерация ответа
// ассистента) из ChatModule и PushService (глобальный) из PushModule.
@Module({
  imports: [ChatModule, AccountDeletionModule],
  controllers: [RoutinePushController],
  providers: [RoutinePushService, RoutineAccountDeletionAdapter],
  exports: [RoutinePushService],
})
export class RoutinePushModule {}
