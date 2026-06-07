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
import { AttributionService } from './product/attribution.service';
import { SmsHealthService } from './sms-health.service';
import { OpenRouterHealthService } from './openrouter-health.service';
import { ElevenLabsHealthService } from './elevenlabs-health.service';
import { ClaudeHealthService } from './claude-health.service';
import { BackupHealthService } from './backup-health.service';
import { ModelsRegistryService } from './models-registry.service';
import { JobsMonitorService } from './jobs-monitor.service';
import { ReplicationHealthService } from './replication-health.service';
import { NeoSnapshotHealthService } from './neo-snapshot-health.service';
import { MinioMirrorHealthService } from './minio-mirror-health.service';
import { CommonModule } from '../common/common.module';
import { Neo4jModule } from '../neo4j/neo4j.module';

@Module({
  imports: [CommonModule, Neo4jModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, LogsService, SyntheticService, FunnelService, EconomyService, QualityService, ProfileDepthService, SummaryService, NetworkingService, ChurnService, SupportService, ContentService, PersonasService, AttributionService, SmsHealthService, OpenRouterHealthService, ElevenLabsHealthService, ClaudeHealthService, BackupHealthService, ModelsRegistryService, JobsMonitorService, ReplicationHealthService, NeoSnapshotHealthService, MinioMirrorHealthService],
})
export class MonitoringModule {}
