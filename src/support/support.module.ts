import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { Neo4jModule } from '../neo4j/neo4j.module';
import { VideoModule } from '../video/video.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { HealthProbeService } from './health-probe.service';
import { TelegramNotifierService } from './telegram-notifier.service';
import { SupportAccountDeletionAdapter } from './support-account-deletion.adapter';

@Module({
  imports: [CommonModule, Neo4jModule, VideoModule, AccountDeletionModule],
  controllers: [SupportController],
  providers: [
    SupportService,
    HealthProbeService,
    TelegramNotifierService,
    SupportAccountDeletionAdapter,
  ],
  exports: [SupportService],
})
export class SupportModule {}
