import { Module } from '@nestjs/common';
import { VpmController } from './vpm.controller';
import { VpmService } from './vpm.service';
import { CommonModule } from '../common/common.module';
import { BacklogModule } from '../backlog/backlog.module';

@Module({
  imports: [CommonModule, BacklogModule],
  controllers: [VpmController],
  providers: [VpmService],
})
export class VpmModule {}
