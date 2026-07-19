import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatToolsService } from './chat-tools';
import { ClaudeAgentService } from './claude-agent.service';
import { MiscModule } from '../misc/misc.module';
import { CommonModule } from '../common/common.module';
import { VideoModule } from '../video/video.module';
import { SmmModule } from '../smm/smm.module';
import { CalendarModule } from '../calendar/calendar.module';

@Module({
  imports: [MiscModule, CommonModule, VideoModule, SmmModule, CalendarModule],
  controllers: [ChatController],
  providers: [ChatService, ChatToolsService, ClaudeAgentService],
  exports: [ChatToolsService, ChatService],
})
export class ChatModule {}
