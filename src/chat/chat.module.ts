import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatToolsService } from './chat-tools';
import { ClaudeAgentService } from './claude-agent.service';
import { MiscModule } from '../misc/misc.module';
import { CommonModule } from '../common/common.module';
import { VideoModule } from '../video/video.module';
import { SmmModule } from '../smm/smm.module';

@Module({
  imports: [MiscModule, CommonModule, VideoModule, SmmModule],
  controllers: [ChatController],
  providers: [ChatService, ChatToolsService, ClaudeAgentService],
  exports: [ChatToolsService],
})
export class ChatModule {}
