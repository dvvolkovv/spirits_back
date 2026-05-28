import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class OAuthGoogleService {
  private readonly logger = new Logger(OAuthGoogleService.name);
  private readonly clientId = process.env.GOOGLE_CLIENT_ID || '';
  private readonly clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  private readonly redirectUri = `${process.env.PUBLIC_BASE_URL || 'https://my.linkeon.io'}/auth/google/callback`;

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async exchangeCodeForUserinfo(code: string): Promise<{ sub: string; email: string; emailVerified: boolean }> {
    const tokenResp = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const accessToken = tokenResp.data?.access_token;
    if (!accessToken) throw new Error('no access_token from Google');

    const userinfo = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const { sub, email, email_verified } = userinfo.data || {};
    if (!sub || !email) throw new Error('Google userinfo missing sub/email');
    return { sub, email, emailVerified: Boolean(email_verified) };
  }
}
