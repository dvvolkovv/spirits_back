import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { LiveKitClient } from '../voice-call/livekit.client';
import { RoomController } from './room.controller';
import { RoomRateLimit } from './room-rate-limit';
import { RoomService } from './room.service';

/**
 * Голосовые комнаты Linkeon.
 *
 * LiveKitClient объявлен здесь, а не взят из VoiceCallModule намеренно. Он без
 * состояния и без зависимостей (читает env), зато импорт VoiceCallModule
 * притащил бы за собой ChatModule — а ChatModule в свою очередь будет
 * импортировать этот модуль, когда научится разворачивать ссылку на комнату
 * в карточку. Получился бы цикл на ровном месте.
 */
@Module({
  imports: [CommonModule],
  controllers: [RoomController],
  providers: [RoomService, RoomRateLimit, LiveKitClient],
  exports: [RoomService],
})
export class MeetingModule {}
