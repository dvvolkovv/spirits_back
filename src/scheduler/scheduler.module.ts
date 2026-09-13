import { Module } from '@nestjs/common';
import { TokenAccountingService } from './token-accounting.service';
import { ProfileCompactionService } from './profile-compaction.service';
import { TaskArchiverService } from './task-archiver.service';
import { ActivationNudgeService } from './activation-nudge.service';

@Module({
  providers: [TokenAccountingService, ProfileCompactionService, TaskArchiverService, ActivationNudgeService],
  exports: [ProfileCompactionService],
})
export class SchedulerModule {}
