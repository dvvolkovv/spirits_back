import { Module } from '@nestjs/common';
import { TripController } from './trip.controller';
import { TripService } from './trip.service';
import { CommonModule } from '../common/common.module';
import { CalendarModule } from '../calendar/calendar.module';

@Module({
  imports: [CommonModule, CalendarModule],
  controllers: [TripController],
  providers: [TripService],
  exports: [TripService],
})
export class TripModule {}
