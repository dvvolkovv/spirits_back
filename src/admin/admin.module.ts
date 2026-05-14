import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { CommonModule } from '../common/common.module';
import { SchedulerModule } from '../scheduler/scheduler.module';

@Module({
  imports: [CommonModule, SchedulerModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
