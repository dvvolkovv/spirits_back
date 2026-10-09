import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatToolsService } from './chat-tools';
import { MiscModule } from '../misc/misc.module';
import { RoomModule } from '../meeting/room.module';
import { CommonModule } from '../common/common.module';
import { VideoModule } from '../video/video.module';
import { CalendarModule } from '../calendar/calendar.module';
import { TalerIdModule } from '../talerid/talerid.module';
import { SpeechModule } from '../speech/speech.module';
import { TokensModule } from '../tokens/tokens.module';
import { ChatFileStore } from './chat-files/chat-file-store';
import { ChatFilesController } from './chat-files/chat-files.controller';
import { ChatFilesService } from './chat-files/chat-files.service';

@Module({
  imports: [MiscModule, CommonModule, RoomModule, VideoModule, CalendarModule, TalerIdModule, SpeechModule, TokensModule],
  controllers: [ChatController, ChatFilesController],
  providers: [ChatService, ChatToolsService, ChatFileStore, ChatFilesService],
  exports: [ChatToolsService, ChatService, ChatFilesService],
})
export class ChatModule {}
