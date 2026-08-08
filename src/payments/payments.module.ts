import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PriemController } from './priem.controller';
import { PriemService } from './priem.service';
import { ReferralModule } from '../referral/referral.module';

@Module({
  imports: [ReferralModule],
  controllers: [PaymentsController, PriemController],
  providers: [PaymentsService, PriemService],
  exports: [PriemService],
})
export class PaymentsModule {}
