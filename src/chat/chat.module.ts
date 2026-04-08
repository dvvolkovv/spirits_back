import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { MiscModule } from '../misc/misc.module';

@Module({
  imports: [MiscModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
