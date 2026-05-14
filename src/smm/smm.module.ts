// src/smm/smm.module.ts
import { Module } from '@nestjs/common';
import { SmmController } from './smm.controller';
import { SmmBillingService } from './billing/smm-billing.service';
import { SmmPricingService } from './billing/smm-pricing.service';
import { SocialAccountService } from './social-accounts/social-account.service';

@Module({
  controllers: [SmmController],
  providers: [
    SmmBillingService,
    SmmPricingService,
    SocialAccountService,
  ],
  exports: [
    SmmBillingService,
    SmmPricingService,
    SocialAccountService,
  ],
})
export class SmmModule {}
