import { Module } from '@nestjs/common';
import { VpmController } from './vpm.controller';
import { VpmService } from './vpm.service';
import { PersonasService } from '../monitoring/product/personas.service';
import { CommonModule } from '../common/common.module';
import { BacklogModule } from '../backlog/backlog.module';

@Module({
  imports: [CommonModule, BacklogModule],
  controllers: [VpmController],
  // PersonasService is a stateless query service (deps: global PgService only,
  // no crons) — provided here directly so the VPM snapshot can include persona
  // segments without importing all of MonitoringModule.
  providers: [VpmService, PersonasService],
})
export class VpmModule {}
