import { Global, Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventsAccountDeletionAdapter } from './events-account-deletion.adapter';

@Global()
@Module({
  imports: [CommonModule, AccountDeletionModule],
  controllers: [EventsController],
  providers: [EventsService, EventsAccountDeletionAdapter],
  exports: [EventsService],
})
export class EventsModule {}
