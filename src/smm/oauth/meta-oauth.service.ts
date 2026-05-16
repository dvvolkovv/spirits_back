// src/smm/oauth/meta-oauth.service.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class MetaOAuthService {
  private readonly logger = new Logger(MetaOAuthService.name);

  buildAuthorizeUrl(state: string): string {
    const appId = process.env.META_APP_ID;
    const redirectBase = process.env.OAUTH_REDIRECT_BASE ?? 'https://my.linkeon.io';
    if (!appId) throw new Error('META_APP_ID not configured');
    const redirectUri = `${redirectBase}/webhook/smm/oauth/instagram/callback`;
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management',
      state,
    });
    return `https://www.facebook.com/v18.0/dialog/oauth?${params}`;
  }

  async exchangeCode(code: string): Promise<{
    accessToken: string;
    igUserId: string;
    pageId: string;
    displayName: string;
  }> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const redirectBase = process.env.OAUTH_REDIRECT_BASE ?? 'https://my.linkeon.io';
    if (!appId || !appSecret) throw new Error('META_APP_ID/SECRET not configured');
    const redirectUri = `${redirectBase}/webhook/smm/oauth/instagram/callback`;

    // Step 1: Short-lived user access token
    const tokenResp = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (tokenResp.status !== 200 || !tokenResp.data?.access_token) {
      throw new Error(`Meta token exchange failed: ${tokenResp.status} ${JSON.stringify(tokenResp.data).slice(0, 200)}`);
    }
    const shortToken = tokenResp.data.access_token;

    // Step 2: Exchange short-lived for long-lived (60-day) token
    const longResp = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken,
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (longResp.status !== 200 || !longResp.data?.access_token) {
      throw new Error(`Meta long-token exchange failed: ${longResp.status} ${JSON.stringify(longResp.data).slice(0, 200)}`);
    }
    const longLivedToken = longResp.data.access_token;

    // Step 3: Find first Facebook Page → its linked Instagram Business Account
    const pagesResp = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
      params: { access_token: longLivedToken },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (pagesResp.status !== 200 || !pagesResp.data?.data?.length) {
      throw new Error(`Meta /me/accounts returned no pages — user has no FB Page linked`);
    }
    const page = pagesResp.data.data[0];
    const pageId = page.id;
    const pageAccessToken = page.access_token;

    // Step 4: Get IG business account id linked to this page
    const igResp = await axios.get(`https://graph.facebook.com/v18.0/${pageId}`, {
      params: { fields: 'instagram_business_account', access_token: pageAccessToken },
      timeout: 15000,
      validateStatus: () => true,
    });
    const igUserId = igResp.data?.instagram_business_account?.id;
    if (!igUserId) {
      throw new Error(`Page ${pageId} has no linked Instagram Business Account`);
    }

    // Step 5: Get IG account display name (username)
    let displayName = 'Instagram account';
    try {
      const igDataResp = await axios.get(`https://graph.facebook.com/v18.0/${igUserId}`, {
        params: { fields: 'username,name', access_token: pageAccessToken },
        timeout: 10000,
        validateStatus: () => true,
      });
      if (igDataResp.status === 200) {
        displayName = igDataResp.data.username ?? igDataResp.data.name ?? displayName;
      }
    } catch {}

    return {
      accessToken: pageAccessToken,
      igUserId,
      pageId,
      displayName,
    };
  }
}
