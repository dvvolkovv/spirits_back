import { Module } from '@nestjs/common';
import { BacklogController } from './backlog.controller';
import { BacklogService } from './backlog.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [BacklogController],
  providers: [BacklogService],
  exports: [BacklogService],
})
export class BacklogModule {}
