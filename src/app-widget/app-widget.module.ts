import { Module } from '@nestjs/common';
import { AppWidgetController } from './app-widget.controller';
import { EnergyFocusService } from './energy-focus.service';

@Module({
  controllers: [AppWidgetController],
  providers: [EnergyFocusService],
})
export class AppWidgetModule {}
