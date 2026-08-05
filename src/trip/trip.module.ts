import { Module } from '@nestjs/common';
import { TripController } from './trip.controller';
import { TripService } from './trip.service';
import { CommonModule } from '../common/common.module';
import { CalendarModule } from '../calendar/calendar.module';
import { TalerIdModule } from '../talerid/talerid.module';
// Ф3 day framing [2026-08-05]: TripService.generateFramingAsync reuse'ит ChatService.generateAgentReply
// (тот же LLM-путь, что routine-push.service.ts) — нужен ChatModule в графе, циклов нет (проверено:
// ChatModule -> {Misc, Common, Video, Smm, Calendar, TalerId}, ничто из этого не ведёт обратно в TripModule).
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [CommonModule, CalendarModule, TalerIdModule, ChatModule],
  controllers: [TripController],
  providers: [TripService],
  exports: [TripService],
})
export class TripModule {}
