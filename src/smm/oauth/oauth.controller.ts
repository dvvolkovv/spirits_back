// src/smm/oauth/oauth.controller.ts
import {
  Controller, Get, Logger, Param, Query, Req, Res, UseGuards, BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { OAuthStateService, Platform } from './oauth-state.service';
import { VkOAuthService } from './vk-oauth.service';
import { YouTubeOAuthService } from './youtube-oauth.service';
import { TikTokOAuthService } from './tiktok-oauth.service';
import { MetaOAuthService } from './meta-oauth.service';
import { SocialAccountService } from '../social-accounts/social-account.service';

@Controller('smm/oauth')
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);

  constructor(
    private readonly state: OAuthStateService,
    private readonly vk: VkOAuthService,
    private readonly yt: YouTubeOAuthService,
    private readonly tt: TikTokOAuthService,
    private readonly meta: MetaOAuthService,
    private readonly accounts: SocialAccountService,
  ) {}

  /**
   * Admin-only entrypoint. Returns a redirect URL the frontend opens.
   * Could also redirect directly via 302, but returning the URL lets the
   * frontend control whether to open in a new tab.
   */
  @Get(':platform/start')
  @UseGuards(JwtGuard, AdminGuard)
  async start(
    @Req() req: any,
    @Param('platform') platform: string,
    @Query('redirect') redirect?: string,
  ): Promise<{ authorizeUrl: string }> {
    if (!['vk', 'youtube', 'tiktok', 'instagram'].includes(platform)) {
      throw new BadRequestException(`unsupported platform: ${platform}`);
    }
    const stateToken = await this.state.create(req.user.phone, platform as Platform, redirect);
    let authorizeUrl: string;
    switch (platform) {
      case 'vk':        authorizeUrl = this.vk.buildAuthorizeUrl(stateToken); break;
      case 'youtube':   authorizeUrl = this.yt.buildAuthorizeUrl(stateToken); break;
      case 'tiktok':    authorizeUrl = this.tt.buildAuthorizeUrl(stateToken); break;
      case 'instagram': authorizeUrl = this.meta.buildAuthorizeUrl(stateToken); break;
      default: throw new BadRequestException(`unsupported platform: ${platform}`);
    }
    return { authorizeUrl };
  }

  /**
   * OAuth callback from the platform. NOT guarded — platform redirects here
   * with code+state in URL. State validates the user identity.
   */
  @Get(':platform/callback')
  async callback(
    @Param('platform') platform: string,
    @Query('code') code: string,
    @Query('state') stateToken: string,
    @Query('error') error: string,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      this.logger.warn(`OAuth ${platform} callback error: ${error}`);
      res.redirect(`/?smm_oauth_error=${encodeURIComponent(error)}`);
      return;
    }
    if (!code || !stateToken) {
      res.redirect(`/?smm_oauth_error=missing_params`);
      return;
    }
    if (!['vk', 'youtube', 'tiktok', 'instagram'].includes(platform)) {
      res.redirect(`/?smm_oauth_error=bad_platform`);
      return;
    }
    let userId: string;
    let userRedirect: string | null;
    try {
      const consumed = await this.state.consume(stateToken, platform as Platform);
      userId = consumed.userId;
      userRedirect = consumed.redirectUrl;
    } catch (e: any) {
      res.redirect(`/?smm_oauth_error=invalid_state`);
      return;
    }

    try {
      let credentials: Record<string, unknown>;
      let displayName: string;
      switch (platform) {
        case 'vk': {
          const r = await this.vk.exchangeCode(code);
          credentials = { accessToken: r.accessToken, userId: r.userId, expiresIn: r.expiresIn };
          displayName = r.displayName;
          break;
        }
        case 'youtube': {
          const r = await this.yt.exchangeCode(code);
          credentials = {
            accessToken: r.accessToken,
            refreshToken: r.refreshToken,
            channelId: r.channelId,
            expiresIn: r.expiresIn,
            issuedAt: new Date().toISOString(),
          };
          displayName = r.displayName;
          break;
        }
        case 'tiktok': {
          const r = await this.tt.exchangeCode(code);
          credentials = {
            accessToken: r.accessToken,
            refreshToken: r.refreshToken,
            openId: r.openId,
            expiresIn: r.expiresIn,
            refreshExpiresIn: r.refreshExpiresIn,
          };
          displayName = r.displayName;
          break;
        }
        case 'instagram': {
          const r = await this.meta.exchangeCode(code);
          credentials = { accessToken: r.accessToken, igUserId: r.igUserId, pageId: r.pageId };
          displayName = r.displayName;
          break;
        }
        default: throw new Error(`unsupported`);
      }

      // Persist the social account
      await this.accounts.create({
        userId,
        platform: platform as Platform,
        displayName,
        credentialsPlain: credentials,
        expiresAt: null,
      });

      const dest = userRedirect ?? `/?smm_oauth_success=${platform}`;
      res.redirect(dest);
    } catch (e: any) {
      this.logger.error(`OAuth ${platform} exchange failed: ${e.message}`);
      res.redirect(`/?smm_oauth_error=${encodeURIComponent(e.message.slice(0, 80))}`);
    }
  }
}
