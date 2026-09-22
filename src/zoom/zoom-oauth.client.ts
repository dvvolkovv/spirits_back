import axios from 'axios';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Разговор с Zoom по OAuth: обмен кода, обновление токена и выдача OBF.
 *
 * Отдельно от хранилища и от бизнес-логики — здесь только HTTP и формат Zoom.
 * Так его можно проверить тестом, подменив axios, не заводя ни базы, ни Nest.
 */

const AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
const TOKEN_URL = 'https://zoom.us/oauth/token';
const API_BASE = 'https://api.zoom.us/v2';

/** Сколько ждём Zoom. Дольше держать вход человека нельзя. */
const TIMEOUT_MS = 10_000;

export interface ZoomTokens {
  accessToken: string;
  refreshToken: string;
  /** Когда протухнет доступ. Zoom выдаёт час. */
  expiresAt: Date;
  scopes: string;
}

@Injectable()
export class ZoomOauthClient {
  private readonly logger = new Logger(ZoomOauthClient.name);

  private get clientId(): string {
    return process.env.ZOOM_SDK_CLIENT_ID || '';
  }

  private get clientSecret(): string {
    return process.env.ZOOM_SDK_CLIENT_SECRET || '';
  }

  /**
   * Адрес возврата.
   *
   * Он же зарегистрирован в кабинете Zoom и обязан совпадать символ в символ —
   * иначе обмен кода отвергается. Ведёт на НАШУ ручку, а не на страницу фронта:
   * код в браузере не нужен никому, кроме нас, и путь через SPA только добавил
   * бы шаг, на котором его можно потерять.
   */
  redirectUri(): string {
    const base = (process.env.PUBLIC_BASE_URL || 'https://my.linkeon.io').replace(/\/+$/, '');
    return `${base}/webhook/ecosystem/zoom/oauth/callback`;
  }

  configured(): boolean {
    return !!this.clientId && !!this.clientSecret;
  }

  /** Куда отправить человека за согласием. */
  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
  }

  private parse(data: any): ZoomTokens {
    const ttl = Number(data?.expires_in || 3600);
    return {
      accessToken: String(data?.access_token || ''),
      refreshToken: String(data?.refresh_token || ''),
      // Минута про запас: токен не должен протухнуть между проверкой и вызовом.
      expiresAt: new Date(Date.now() + Math.max(60, ttl - 60) * 1000),
      scopes: String(data?.scope || ''),
    };
  }

  /** Код в токены. Бросает — вызывающий решает, что сказать человеку. */
  async exchangeCode(code: string): Promise<ZoomTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
    });
    const r = await axios.post(TOKEN_URL, body, {
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: TIMEOUT_MS,
    });
    return this.parse(r.data);
  }

  /**
   * Обновление доступа.
   *
   * Refresh у Zoom РОТИРУЕТСЯ: ответ приносит новый, а прежний перестаёт
   * работать. Поэтому вызывающий обязан сохранить оба поля целиком, а не
   * только access, — иначе следующее обновление упрётся в мёртвый refresh.
   */
  async refresh(refreshToken: string): Promise<ZoomTokens> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const r = await axios.post(TOKEN_URL, body, {
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: TIMEOUT_MS,
    });
    return this.parse(r.data);
  }

  /** Кто подключился — чтобы показать человеку, чей аккаунт привязан. */
  async me(accessToken: string): Promise<{ id: string; accountId: string; email: string }> {
    const r = await axios.get(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: TIMEOUT_MS,
    });
    return {
      id: String(r.data?.id || ''),
      accountId: String(r.data?.account_id || ''),
      email: String(r.data?.email || ''),
    };
  }

  /**
   * Токен On-Behalf-Of для конкретной встречи.
   *
   * Короткоживущий и одноразовый: берётся на каждый вход заново. Zoom выдаёт
   * его только если авторизовавший пользователь имеет отношение к встрече, а
   * вход по нему удастся лишь когда этот человек в комнате — отказ до его
   * прихода нормален и лечится повтором, а не паникой.
   */
  async onBehalfToken(accessToken: string, meetingNumber: string): Promise<string> {
    const r = await axios.get(`${API_BASE}/users/me/token`, {
      params: { type: 'onbehalf', meeting_id: meetingNumber },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: TIMEOUT_MS,
    });
    return String(r.data?.token || '');
  }
}
