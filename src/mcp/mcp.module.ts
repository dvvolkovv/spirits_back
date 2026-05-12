import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [ChatModule],
  controllers: [McpController],
})
export class McpModule {}
