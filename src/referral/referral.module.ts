import { Module } from '@nestjs/common';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';
import { ReferralAccountDeletionAdapter } from './referral-account-deletion.adapter';

@Module({
  imports: [AccountDeletionModule],
  controllers: [ReferralController],
  providers: [ReferralService, ReferralAccountDeletionAdapter],
  exports: [ReferralService],
})
export class ReferralModule {}
