import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { FunnelService } from './product/funnel.service';
import { EconomyService } from './product/economy.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, FunnelService, EconomyService],
})
export class MonitoringModule {}
