// src/smm/oauth/tiktok-oauth.service.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class TikTokOAuthService {
  private readonly logger = new Logger(TikTokOAuthService.name);

  buildAuthorizeUrl(state: string): string {
    const clientKey = process.env.TIKTOK_OAUTH_CLIENT_KEY;
    const redirectBase = process.env.OAUTH_REDIRECT_BASE ?? 'https://my.linkeon.io';
    if (!clientKey) throw new Error('TIKTOK_OAUTH_CLIENT_KEY not configured');
    const redirectUri = `${redirectBase}/webhook/smm/oauth/tiktok/callback`;
    const params = new URLSearchParams({
      client_key: clientKey,
      response_type: 'code',
      scope: 'user.info.basic,video.publish,video.upload',
      redirect_uri: redirectUri,
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize?${params}`;
  }

  async exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken: string;
    openId: string;
    expiresIn: number;
    refreshExpiresIn: number;
    displayName: string;
  }> {
    const clientKey = process.env.TIKTOK_OAUTH_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_OAUTH_CLIENT_SECRET;
    const redirectBase = process.env.OAUTH_REDIRECT_BASE ?? 'https://my.linkeon.io';
    if (!clientKey || !clientSecret) throw new Error('TIKTOK_OAUTH_CLIENT_KEY/SECRET not configured');
    const redirectUri = `${redirectBase}/webhook/smm/oauth/tiktok/callback`;

    const tokenResp = await axios.post('https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
        validateStatus: () => true,
      },
    );
    if (tokenResp.status !== 200 || !tokenResp.data?.access_token) {
      throw new Error(`TikTok token exchange failed: ${tokenResp.status} ${JSON.stringify(tokenResp.data).slice(0, 200)}`);
    }
    const { access_token, refresh_token, open_id, expires_in, refresh_expires_in } = tokenResp.data;

    // Resolve display name
    let displayName = 'TikTok account';
    try {
      const userResp = await axios.get('https://open.tiktokapis.com/v2/user/info/', {
        params: { fields: 'display_name,username' },
        headers: { Authorization: `Bearer ${access_token}` },
        timeout: 10000,
        validateStatus: () => true,
      });
      if (userResp.status === 200 && userResp.data?.data?.user) {
        displayName = userResp.data.data.user.display_name ?? userResp.data.data.user.username ?? displayName;
      }
    } catch {}

    return {
      accessToken: access_token,
      refreshToken: refresh_token,
      openId: open_id,
      expiresIn: expires_in,
      refreshExpiresIn: refresh_expires_in,
      displayName,
    };
  }
}
