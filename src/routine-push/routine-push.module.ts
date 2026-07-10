import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { RoutinePushService } from './routine-push.service';
import { RoutinePushController } from './routine-push.controller';

// Слой 3: проактивные рутинные пуши. Тянет ChatService (генерация ответа
// ассистента) из ChatModule и PushService (глобальный) из PushModule.
@Module({
  imports: [ChatModule],
  controllers: [RoutinePushController],
  providers: [RoutinePushService],
  exports: [RoutinePushService],
})
export class RoutinePushModule {}
