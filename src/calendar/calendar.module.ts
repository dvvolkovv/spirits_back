import { Module, OnModuleInit } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { CalendarService } from './calendar.service';

@Module({
  imports: [CommonModule],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule implements OnModuleInit {
  constructor(private readonly svc: CalendarService) {}
  async onModuleInit() { await this.svc.ensureTable(); }
}
