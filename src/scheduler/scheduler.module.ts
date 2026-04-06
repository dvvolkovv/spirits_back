import { Module } from '@nestjs/common';
import { TokenAccountingService } from './token-accounting.service';

@Module({
  providers: [TokenAccountingService],
})
export class SchedulerModule {}
