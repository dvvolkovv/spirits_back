import { Module } from '@nestjs/common';
import { VmmController } from './vmm.controller';
import { VmmService } from './vmm.service';
import { PersonasService } from '../monitoring/product/personas.service';
import { CommonModule } from '../common/common.module';
import { BacklogModule } from '../backlog/backlog.module';

@Module({
  imports: [CommonModule, BacklogModule],
  controllers: [VmmController],
  // PersonasService — stateless query service (deps: PgService only), provided
  // here directly so the marketing snapshot can include persona segments without
  // importing all of MonitoringModule (mirrors VpmModule).
  providers: [VmmService, PersonasService],
})
export class VmmModule {}
