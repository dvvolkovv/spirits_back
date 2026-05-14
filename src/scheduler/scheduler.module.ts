import { Module } from '@nestjs/common';
import { TokenAccountingService } from './token-accounting.service';
import { ProfileCompactionService } from './profile-compaction.service';

@Module({
  providers: [TokenAccountingService, ProfileCompactionService],
  exports: [ProfileCompactionService],
})
export class SchedulerModule {}
