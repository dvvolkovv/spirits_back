import { Module, OnModuleInit } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { TalerIdModule } from '../talerid/talerid.module';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { LinkeonTasksService } from './linkeon-tasks.service';

@Module({
  imports: [CommonModule, TalerIdModule],
  controllers: [CalendarController],
  providers: [CalendarService, LinkeonTasksService],
  exports: [CalendarService, LinkeonTasksService],
})
export class CalendarModule implements OnModuleInit {
  constructor(
    private readonly svc: CalendarService,
    private readonly linkeonTasks: LinkeonTasksService,
  ) {}
  async onModuleInit() {
    await this.svc.ensureTable();
    await this.linkeonTasks.ensureTable();
  }
}
