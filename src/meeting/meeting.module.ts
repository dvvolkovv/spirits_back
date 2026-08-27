import { forwardRef, Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { VoiceCallModule } from '../voice-call/voice-call.module';
import { MeetingController } from './meeting.controller';
import { MeetingService } from './meeting.service';
import { RoomModule } from './room.module';

/**
 * Присутствие ассистента во встрече.
 *
 * Сами комнаты живут в RoomModule и ничего про ассистента не знают: они и без
 * него работают — люди могут собраться и поговорить сами.
 *
 * Связь с VoiceCallModule обоюдная, и это не небрежность: нам нужен
 * VoiceCallService (preamble, завершение, загрузка записи), а ему — наш
 * MeetingService, потому что ручку «во встречу пришёл первый человек» зовёт
 * воркер, и она обязана лежать под тем же подписанным префиксом
 * /webhook/voice-call/internal, что и остальные его вызовы. Отсюда forwardRef
 * с обеих сторон.
 */
@Module({
  imports: [CommonModule, RoomModule, forwardRef(() => VoiceCallModule)],
  controllers: [MeetingController],
  providers: [MeetingService],
  exports: [MeetingService],
})
export class MeetingModule {}
