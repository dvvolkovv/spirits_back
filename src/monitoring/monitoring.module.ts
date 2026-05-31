import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { LogsService } from './logs.service';
import { SyntheticService } from './synthetic.service';
import { FunnelService } from './product/funnel.service';
import { EconomyService } from './product/economy.service';
import { QualityService } from './product/quality.service';
import { ProfileDepthService } from './product/profile-depth.service';
import { SummaryService } from './product/summary.service';
import { NetworkingService } from './product/networking.service';
import { ChurnService } from './product/churn.service';
import { SupportService } from './product/support.service';
import { ContentService } from './product/content.service';
import { PersonasService } from './product/personas.service';
import { SmsHealthService } from './sms-health.service';
import { CommonModule } from '../common/common.module';
import { Neo4jModule } from '../neo4j/neo4j.module';

@Module({
  imports: [CommonModule, Neo4jModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, LogsService, SyntheticService, FunnelService, EconomyService, QualityService, ProfileDepthService, SummaryService, NetworkingService, ChurnService, SupportService, ContentService, PersonasService, SmsHealthService],
})
export class MonitoringModule {}
