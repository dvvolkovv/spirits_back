import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class OAuthYandexService {
  private readonly logger = new Logger(OAuthYandexService.name);
  private readonly clientId = process.env.YANDEX_CLIENT_ID || '';
  private readonly clientSecret = process.env.YANDEX_CLIENT_SECRET || '';
  private readonly redirectUri = `${process.env.PUBLIC_BASE_URL || 'https://my.linkeon.io'}/auth/yandex/callback`;

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state,
    });
    return `https://oauth.yandex.ru/authorize?${params}`;
  }

  async exchangeCodeForUserinfo(code: string): Promise<{ sub: string; email: string; emailVerified: boolean }> {
    const tokenResp = await axios.post('https://oauth.yandex.ru/token', new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'authorization_code',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const accessToken = tokenResp.data?.access_token;
    if (!accessToken) throw new Error('no access_token from Yandex');

    const userinfo = await axios.get('https://login.yandex.ru/info?format=json', {
      headers: { Authorization: `OAuth ${accessToken}` },
    });
    const { id, default_email } = userinfo.data || {};
    if (!id || !default_email) throw new Error('Yandex userinfo missing id/default_email');
    return { sub: String(id), email: default_email, emailVerified: true };
  }
}
