import { YoutubeAuthError, YoutubeCodeRejected, YoutubeNotUploaded } from './youtube-errors';
import { Http, HttpResponse, clip, googleReason } from './youtube-http';

/** Загрузка и чтение своего канала: channels.list?mine=true — узнать, какой канал подключил владелец. */
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

/** Под глобальным префиксом webhook; ровно этот путь зарегистрирован в Google Cloud для теста и прода. */
export const CALLBACK_PATH = '/webhook/shorts/youtube/oauth/callback';

export interface YoutubeOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Клиент OAuth из .env или null, если на этой среде YouTube не настроен. */
export function youtubeOAuthConfig(env: NodeJS.ProcessEnv = process.env): YoutubeOAuthConfig | null {
  const clientId = (env.YOUTUBE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (env.YOUTUBE_OAUTH_CLIENT_SECRET || '').trim();
  // Без своего адреса среда не может принять возврат; подставлять прод нельзя — туда ушли бы state и подключение.
  const base = (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!clientId || !clientSecret || !base) return null;
  return { clientId, clientSecret, redirectUri: `${base}${CALLBACK_PATH}` };
}

/** offline — чтобы Google выдал refresh-токен; consent — чтобы выдал его и при повторном подключении. */
export function authorizeUrl(cfg: YoutubeOAuthConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${q}`;
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();

export async function exchangeCode(
  http: Http,
  cfg: YoutubeOAuthConfig,
  code: string,
): Promise<{ accessToken: string; refreshToken: string; scope: string }> {
  const r = await http({
    method: 'POST',
    url: TOKEN_URL,
    headers: FORM,
    timeout: 15_000,
    data: form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, code, grant_type: 'authorization_code' }),
  });
  if (r.status !== 200 || !r.data?.access_token) {
    if (r.data?.error === 'invalid_grant') throw new YoutubeCodeRejected(`обмен кода: ${googleReason(r)}`);
    throw new Error(`обмен кода: ${googleReason(r)}`);
  }
  if (!r.data.refresh_token) {
    throw new Error('Google не выдал refresh-токен — уберите доступ приложения в настройках аккаунта Google и подключите снова');
  }
  // На экране согласия у каждого разрешения своя галочка: без загрузки каждый ролик получал бы 403.
  const granted = String(r.data.scope || '').split(/\s+/);
  if (!YOUTUBE_SCOPES.every((s) => granted.includes(s))) {
    throw new Error('Google не дал доступ на загрузку видео — подключите снова и отметьте все разрешения на экране Google');
  }
  return { accessToken: r.data.access_token, refreshToken: r.data.refresh_token, scope: String(r.data.scope) };
}

/**
 * Свежий access-токен. invalid_grant и unauthorized_client — доступ отозван или протух:
 * YoutubeAuthError, нужно переподключение. Прочие сбои (сеть, 5xx, invalid_client) —
 * YoutubeNotUploaded: до загрузки не дошло, повтор безопасен.
 */
export async function refreshAccessToken(http: Http, cfg: YoutubeOAuthConfig, refreshToken: string): Promise<string> {
  let r: HttpResponse;
  try {
    r = await http({
      method: 'POST',
      url: TOKEN_URL,
      headers: FORM,
      timeout: 15_000,
      data: form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
  } catch (e: any) {
    throw new YoutubeNotUploaded(`обновление токена: ${clip(String(e?.message ?? e), 200)}`);
  }
  if (r.status === 200 && r.data?.access_token) return r.data.access_token;
  if (r.data?.error === 'invalid_grant' || r.data?.error === 'unauthorized_client') throw new YoutubeAuthError(googleReason(r));
  throw new YoutubeNotUploaded(`обновление токена: ${googleReason(r)}`, r.status);
}

/** Канал, который владелец выбрал при входе. */
export async function fetchMyChannel(http: Http, accessToken: string): Promise<{ id: string; title: string; handle: string | null }> {
  const r = await http({
    method: 'GET',
    url: CHANNELS_URL,
    params: { part: 'snippet', mine: 'true' },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15_000,
  });
  const ch = r.status === 200 ? r.data?.items?.[0] : null;
  if (!ch?.id) {
    throw new Error(r.status === 200 ? 'у аккаунта нет канала YouTube — выберите при входе канал Linkeon' : `канал: ${googleReason(r)}`);
  }
  return { id: ch.id, title: ch.snippet?.title ?? ch.id, handle: ch.snippet?.customUrl ?? null };
}
