// src/smm/oauth/vk-oauth.service.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const VK_API_VERSION = '5.199';

@Injectable()
export class VkOAuthService {
  private readonly logger = new Logger(VkOAuthService.name);

  buildAuthorizeUrl(state: string): string {
    const clientId = process.env.VK_OAUTH_CLIENT_ID;
    const redirectBase = process.env.OAUTH_REDIRECT_BASE ?? 'https://my.linkeon.io';
    if (!clientId) throw new Error('VK_OAUTH_CLIENT_ID not configured');
    const redirectUri = `${redirectBase}/webhook/smm/oauth/vk/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      display: 'page',
      redirect_uri: redirectUri,
      scope: 'video,wall,offline,groups',
      response_type: 'code',
      state,
      v: VK_API_VERSION,
    });
    return `https://oauth.vk.com/authorize?${params}`;
  }

  /**
   * Exchange the OAuth code for an access_token.
   * Returns the credentials object to encrypt and store in smm_social_account.
   */
  async exchangeCode(code: string): Promise<{
    accessToken: string;
    userId: number;
    expiresIn: number;        // seconds; 0 means non-expiring (with offline scope)
    displayName: string;
  }> {
    const clientId = process.env.VK_OAUTH_CLIENT_ID;
    const clientSecret = process.env.VK_OAUTH_CLIENT_SECRET;
    const redirectBase = process.env.OAUTH_REDIRECT_BASE ?? 'https://my.linkeon.io';
    if (!clientId || !clientSecret) throw new Error('VK_OAUTH_CLIENT_ID/SECRET not configured');
    const redirectUri = `${redirectBase}/webhook/smm/oauth/vk/callback`;

    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (tokenResp.status !== 200 || tokenResp.data?.error) {
      throw new Error(`VK token exchange failed: ${tokenResp.status} ${JSON.stringify(tokenResp.data).slice(0, 200)}`);
    }
    const { access_token, expires_in, user_id } = tokenResp.data;
    if (!access_token) throw new Error(`VK token exchange: no access_token in response`);

    // Resolve display name
    let displayName = `vk_user_${user_id}`;
    try {
      const userResp = await axios.get('https://api.vk.com/method/users.get', {
        params: {
          user_ids: user_id,
          access_token,
          v: VK_API_VERSION,
        },
        timeout: 10000,
        validateStatus: () => true,
      });
      if (userResp.status === 200 && Array.isArray(userResp.data?.response)) {
        const u = userResp.data.response[0];
        if (u?.first_name) displayName = `${u.first_name} ${u.last_name ?? ''}`.trim();
      }
    } catch {}

    return {
      accessToken: access_token,
      userId: user_id,
      expiresIn: expires_in ?? 0,
      displayName,
    };
  }
}
