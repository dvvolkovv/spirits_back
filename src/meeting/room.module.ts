import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { RoomController } from './room.controller';
import { RoomRateLimit } from './room-rate-limit';
import { RoomService } from './room.service';

/**
 * Сами комнаты — без ассистента.
 *
 * Вынесены отдельно от MeetingModule намеренно. Комнатой пользуются трое:
 * встречи (ассистент в неё входит), чат (разворачивает ссылку в карточку) и
 * фронт напрямую. Если бы RoomService лежал в MeetingModule, чату пришлось бы
 * импортировать его — а MeetingModule связан с VoiceCallModule, тот с
 * ChatModule, и граф замкнулся бы в кольцо из трёх модулей.
 *
 * Здесь же зависимостей нет вовсе, кроме глобального CommonModule, так что
 * импортировать этот модуль безопасно откуда угодно.
 */
@Module({
  imports: [CommonModule],
  controllers: [RoomController],
  providers: [RoomService, RoomRateLimit],
  exports: [RoomService],
})
export class RoomModule {}
