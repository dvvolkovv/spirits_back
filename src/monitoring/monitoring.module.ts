import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { FunnelService } from './product/funnel.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, FunnelService],
})
export class MonitoringModule {}
