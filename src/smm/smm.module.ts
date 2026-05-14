// src/smm/smm.module.ts
import { Module } from '@nestjs/common';
import { SmmController } from './smm.controller';
import { SmmBillingService } from './billing/smm-billing.service';
import { SmmPricingService } from './billing/smm-pricing.service';
import { SocialAccountService } from './social-accounts/social-account.service';
import { RenderQueueService } from './render/render-queue.service';
import { PublishQueueService } from './publication/publish-queue.service';
import { RenderCallbackController } from './render/render-callback.controller';
import { ScenarioFetchController } from './render/scenario-fetch.controller';
import { MusicService } from './music/music.service';

@Module({
  controllers: [SmmController, RenderCallbackController, ScenarioFetchController],
  providers: [
    SmmBillingService,
    SmmPricingService,
    SocialAccountService,
    RenderQueueService,
    PublishQueueService,
    MusicService,
  ],
  exports: [
    SmmBillingService,
    SmmPricingService,
    SocialAccountService,
    RenderQueueService,
    PublishQueueService,
    MusicService,
  ],
})
export class SmmModule {}
