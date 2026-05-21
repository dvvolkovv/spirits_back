import { Module } from '@nestjs/common';
import { TokenAccountingService } from './token-accounting.service';
import { ProfileCompactionService } from './profile-compaction.service';
import { TaskArchiverService } from './task-archiver.service';

@Module({
  providers: [TokenAccountingService, ProfileCompactionService, TaskArchiverService],
  exports: [ProfileCompactionService],
})
export class SchedulerModule {}
