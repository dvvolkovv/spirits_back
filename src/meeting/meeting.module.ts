import { forwardRef, Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { VoiceCallModule } from '../voice-call/voice-call.module';
import { MeetingController } from './meeting.controller';
import { MeetingService } from './meeting.service';
import { RoomController } from './room.controller';
import { RoomRateLimit } from './room-rate-limit';
import { RoomService } from './room.service';

/**
 * Голосовые комнаты Linkeon и присутствие в них ассистента.
 *
 * Связь с VoiceCallModule обоюдная, и это не небрежность: нам нужен
 * VoiceCallService (preamble, завершение, загрузка записи), а ему — наш
 * MeetingService, потому что ручку «во встречу пришёл первый человек» зовёт
 * воркер, и она обязана лежать под тем же подписанным префиксом
 * /webhook/voice-call/internal, что и остальные его вызовы. Отсюда forwardRef
 * с обеих сторон.
 *
 * LiveKitClient берётся из VoiceCallModule, а не объявляется здесь: два
 * экземпляра работали бы одинаково (он без состояния), но расходились бы при
 * первой же правке.
 */
@Module({
  imports: [CommonModule, forwardRef(() => VoiceCallModule)],
  controllers: [RoomController, MeetingController],
  providers: [RoomService, RoomRateLimit, MeetingService],
  exports: [RoomService, MeetingService],
})
export class MeetingModule {}
