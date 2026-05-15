// src/smm/oauth/youtube-oauth.service.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class YouTubeOAuthService {
  private readonly logger = new Logger(YouTubeOAuthService.name);

  buildAuthorizeUrl(state: string): string {
    const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
    const redirectBase = process.env.OAUTH_REDIRECT_BASE ?? 'https://my.linkeon.io';
    if (!clientId) throw new Error('YOUTUBE_OAUTH_CLIENT_ID not configured');
    const redirectUri = `${redirectBase}/webhook/smm/oauth/youtube/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    displayName: string;
    channelId: string;
  }> {
    const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
    const redirectBase = process.env.OAUTH_REDIRECT_BASE ?? 'https://my.linkeon.io';
    if (!clientId || !clientSecret) throw new Error('YOUTUBE_OAUTH_CLIENT_ID/SECRET not configured');
    const redirectUri = `${redirectBase}/webhook/smm/oauth/youtube/callback`;

    const tokenResp = await axios.post('https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
        grant_type: 'authorization_code',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
        validateStatus: () => true,
      },
    );
    if (tokenResp.status !== 200 || !tokenResp.data?.access_token) {
      throw new Error(`Google token exchange failed: ${tokenResp.status} ${JSON.stringify(tokenResp.data).slice(0, 200)}`);
    }
    const { access_token, refresh_token, expires_in } = tokenResp.data;

    // Resolve YouTube channel info
    const chanResp = await axios.get('https://youtube.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet', mine: 'true' },
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 10000,
      validateStatus: () => true,
    });
    let displayName = 'YouTube channel';
    let channelId = '';
    if (chanResp.status === 200 && Array.isArray(chanResp.data?.items) && chanResp.data.items.length > 0) {
      const ch = chanResp.data.items[0];
      displayName = ch.snippet?.title ?? displayName;
      channelId = ch.id ?? '';
    }

    return {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: expires_in,
      displayName,
      channelId,
    };
  }

  /**
   * Refresh an access token using the refresh_token.
   * The worker uses this when its current access_token is expired.
   */
  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('YOUTUBE_OAUTH_CLIENT_ID/SECRET not configured');
    const resp = await axios.post('https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
        validateStatus: () => true,
      },
    );
    if (resp.status !== 200 || !resp.data?.access_token) {
      throw new Error(`Google token refresh failed: ${resp.status} ${JSON.stringify(resp.data).slice(0, 200)}`);
    }
    return { accessToken: resp.data.access_token, expiresIn: resp.data.expires_in };
  }
}
