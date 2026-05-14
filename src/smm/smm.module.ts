// src/smm/smm.module.ts
import { Module } from '@nestjs/common';
import { SmmController } from './smm.controller';
import { SmmBillingService } from './billing/smm-billing.service';
import { SmmPricingService } from './billing/smm-pricing.service';
import { SocialAccountService } from './social-accounts/social-account.service';
import { RenderQueueService } from './render/render-queue.service';
import { PublishQueueService } from './publication/publish-queue.service';

@Module({
  controllers: [SmmController],
  providers: [
    SmmBillingService,
    SmmPricingService,
    SocialAccountService,
    RenderQueueService,
    PublishQueueService,
  ],
  exports: [
    SmmBillingService,
    SmmPricingService,
    SocialAccountService,
    RenderQueueService,
    PublishQueueService,
  ],
})
export class SmmModule {}
