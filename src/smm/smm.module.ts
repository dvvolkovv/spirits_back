// src/smm/smm.module.ts
import { Module } from '@nestjs/common';
import { SmmController } from './smm.controller';
import { SmmBillingService } from './billing/smm-billing.service';
import { SmmPricingService } from './billing/smm-pricing.service';
import { SocialAccountService } from './social-accounts/social-account.service';
import { RenderQueueService } from './render/render-queue.service';
import { PublishQueueService } from './publication/publish-queue.service';
import { PublicationService } from './publication/publication.service';
import { RenderCallbackController } from './render/render-callback.controller';
import { ScenarioFetchController } from './render/scenario-fetch.controller';
import { MusicService } from './music/music.service';
import { ScenarioService } from './producer/scenario.service';
import { TrendsService } from './producer/trends.service';
import { ApprovalService } from './producer/approval.service';
import { CreatorCampaignService } from './producer/creator-campaign.service';
import { SmmProducerToolsService } from './producer/smm-producer-tools.service';
import { ScenariosController } from './scenarios/scenarios.controller';
import { VideosController } from './videos/videos.controller';
import { BrandingController } from './branding/branding.controller';
import { PublicationContextController } from './publication/publication-context.controller';
import { PublicationCallbackController } from './publication/publication-callback.controller';
import { OAuthStateService } from './oauth/oauth-state.service';
import { VkOAuthService } from './oauth/vk-oauth.service';
import { YouTubeOAuthService } from './oauth/youtube-oauth.service';
import { TikTokOAuthService } from './oauth/tiktok-oauth.service';
import { MetaOAuthService } from './oauth/meta-oauth.service';
import { OAuthController } from './oauth/oauth.controller';
import { SocialAccountController } from './social-accounts/social-account.controller';

@Module({
  controllers: [SmmController, RenderCallbackController, ScenarioFetchController, ScenariosController, VideosController, BrandingController, PublicationContextController, PublicationCallbackController, OAuthController, SocialAccountController],
  providers: [
    SmmBillingService,
    SmmPricingService,
    SocialAccountService,
    RenderQueueService,
    PublishQueueService,
    PublicationService,
    MusicService,
    ScenarioService,
    TrendsService,
    ApprovalService,
    CreatorCampaignService,
    SmmProducerToolsService,
    OAuthStateService,
    VkOAuthService,
    YouTubeOAuthService,
    TikTokOAuthService,
    MetaOAuthService,
  ],
  exports: [
    SmmBillingService,
    SmmPricingService,
    SocialAccountService,
    RenderQueueService,
    PublishQueueService,
    PublicationService,
    MusicService,
    ScenarioService,
    TrendsService,
    ApprovalService,
    CreatorCampaignService,
    SmmProducerToolsService,
    OAuthStateService,
    VkOAuthService,
    YouTubeOAuthService,
    TikTokOAuthService,
    MetaOAuthService,
  ],
})
export class SmmModule {}
