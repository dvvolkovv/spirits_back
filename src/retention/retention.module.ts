import { Module } from '@nestjs/common';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { CommonModule } from '../common/common.module';
import { RetentionRecipientResolver } from './retention-recipient-resolver';
import { RetentionService } from './retention.service';
import { RetentionUnsubscribeController } from './retention-unsubscribe.controller';
import { RetentionUnsubscribeService } from './retention-unsubscribe.service';
import { RetentionAccountDeletionAdapter } from './retention-account-deletion.adapter';

@Module({
  imports: [CommonModule, AccountDeletionModule],
  controllers: [RetentionUnsubscribeController],
  providers: [
    RetentionService,
    RetentionRecipientResolver,
    RetentionUnsubscribeService,
    RetentionAccountDeletionAdapter,
  ],
  exports: [RetentionService],
})
export class RetentionModule {}
