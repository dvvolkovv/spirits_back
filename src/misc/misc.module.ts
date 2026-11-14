import { Module } from '@nestjs/common';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { MiscController } from './misc.controller';
import { MiscService } from './misc.service';
import { VeoService } from './veo.service';
import { ImageAccountDeletionAdapter } from './image-account-deletion.adapter';
import { LegacySmmAccountDeletionAdapter } from './legacy-smm-account-deletion.adapter';

@Module({
  imports: [AccountDeletionModule],
  controllers: [MiscController],
  providers: [MiscService, VeoService, ImageAccountDeletionAdapter, LegacySmmAccountDeletionAdapter],
  exports: [MiscService, VeoService],
})
export class MiscModule {}
