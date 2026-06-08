import { Module } from '@nestjs/common';
import { CustomAgentsController } from './custom-agents.controller';
import { CustomAgentsService } from './custom-agents.service';

@Module({
  controllers: [CustomAgentsController],
  providers: [CustomAgentsService],
  exports: [CustomAgentsService],
})
export class CustomAgentsModule {}
