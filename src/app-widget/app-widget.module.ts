import { Module } from '@nestjs/common';
import { AppWidgetController } from './app-widget.controller';

@Module({
  controllers: [AppWidgetController],
})
export class AppWidgetModule {}
