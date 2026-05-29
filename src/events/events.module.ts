import { Global, Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Global()
@Module({
  imports: [CommonModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
