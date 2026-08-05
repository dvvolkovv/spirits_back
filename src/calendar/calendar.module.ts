import { Module, OnModuleInit } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { TalerIdModule } from '../talerid/talerid.module';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { LinkeonTasksService } from './linkeon-tasks.service';
import { DayFramingStore } from './day-framing.store';

@Module({
  imports: [CommonModule, TalerIdModule],
  controllers: [CalendarController],
  providers: [CalendarService, LinkeonTasksService, DayFramingStore],
  exports: [CalendarService, LinkeonTasksService, DayFramingStore],
})
export class CalendarModule implements OnModuleInit {
  constructor(
    private readonly svc: CalendarService,
    private readonly linkeonTasks: LinkeonTasksService,
  ) {}
  async onModuleInit() {
    await this.svc.ensureTable();
    await this.linkeonTasks.ensureTable();
    // DayFramingStore мигрирует себя сам (implements OnModuleInit) — Nest вызывает
    // его onModuleInit автоматически как провайдера этого модуля, доп. вызов не нужен.
  }
}
