import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { AgentVersionsController } from './agent-versions.controller';
import { AgentVersionsService } from './agent-versions.service';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [ChatModule],
  controllers: [AgentsController, AgentVersionsController],
  providers: [AgentsService, AgentVersionsService],
  exports: [AgentsService, AgentVersionsService],
})
export class AgentsModule {}
