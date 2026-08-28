import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatToolsService } from './chat-tools';
import { ClaudeAgentService } from './claude-agent.service';
import { MiscModule } from '../misc/misc.module';
import { RoomModule } from '../meeting/room.module';
import { CommonModule } from '../common/common.module';
import { VideoModule } from '../video/video.module';
import { SmmModule } from '../smm/smm.module';
import { CalendarModule } from '../calendar/calendar.module';
import { TalerIdModule } from '../talerid/talerid.module';
import { SpeechModule } from '../speech/speech.module';
import { TokensModule } from '../tokens/tokens.module';

@Module({
  imports: [MiscModule, CommonModule, RoomModule, VideoModule, SmmModule, CalendarModule, TalerIdModule, SpeechModule, TokensModule],
  controllers: [ChatController],
  providers: [ChatService, ChatToolsService, ClaudeAgentService],
  exports: [ChatToolsService, ChatService],
})
export class ChatModule {}
