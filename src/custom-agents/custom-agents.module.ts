import { Module } from '@nestjs/common';
import { CustomAgentsController } from './custom-agents.controller';
import { CustomAgentsService } from './custom-agents.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [CustomAgentsController],
  providers: [CustomAgentsService],
  exports: [CustomAgentsService],
})
export class CustomAgentsModule {}
