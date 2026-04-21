import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatToolsService } from './chat-tools';
import { MiscModule } from '../misc/misc.module';
import { CommonModule } from '../common/common.module';
import { VideoModule } from '../video/video.module';

@Module({
  imports: [MiscModule, CommonModule, VideoModule],
  controllers: [ChatController],
  providers: [ChatService, ChatToolsService],
})
export class ChatModule {}
