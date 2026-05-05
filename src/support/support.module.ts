import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { Neo4jModule } from '../neo4j/neo4j.module';
import { VideoModule } from '../video/video.module';
import { SupportController } from './support.controller';
import { SupportTelegramController } from './support-telegram.controller';
import { SupportService } from './support.service';
import { HealthProbeService } from './health-probe.service';
import { TelegramNotifierService } from './telegram-notifier.service';

@Module({
  imports: [CommonModule, Neo4jModule, VideoModule],
  controllers: [SupportController, SupportTelegramController],
  providers: [SupportService, HealthProbeService, TelegramNotifierService],
  exports: [SupportService],
})
export class SupportModule {}
