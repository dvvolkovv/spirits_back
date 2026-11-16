import { Module } from '@nestjs/common';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { DevicesService } from './devices.service';
import { DevicesAccountDeletionAdapter } from './devices-account-deletion.adapter';

@Module({
  imports: [AccountDeletionModule],
  providers: [DevicesService, DevicesAccountDeletionAdapter],
  exports: [DevicesService],
})
export class DevicesModule {}
