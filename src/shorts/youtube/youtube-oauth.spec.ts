import { YoutubeAuthError, YoutubeNotUploaded } from './youtube-errors';
import { HttpRequest, HttpResponse } from './youtube-http';
import { YOUTUBE_SCOPES, authorizeUrl, exchangeCode, fetchMyChannel, refreshAccessToken, youtubeOAuthConfig } from './youtube-oauth';

const CFG = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec', redirectUri: 'https://test.linkeon.io/webhook/shorts/youtube/oauth/callback' };
const reply = (status: number, data: any = {}, headers: any = {}): HttpResponse => ({ status, data, headers });

function fakeHttp(...responses: Array<HttpResponse | Error>) {
  const calls: HttpRequest[] = [];
  const http = jest.fn(async (req: HttpRequest) => {
    calls.push(req);
    const next = responses.shift();
    if (!next) throw new Error(`лишний запрос: ${req.method} ${req.url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  return { http, calls };
}

describe('youtubeOAuthConfig', () => {
  it('без клиента — null', () => {
    expect(youtubeOAuthConfig({})).toBeNull();
    expect(youtubeOAuthConfig({ YOUTUBE_OAUTH_CLIENT_ID: 'x' })).toBeNull();
  });

  it('адрес возврата — от PUBLIC_BASE_URL, без двойного слэша', () => {
    expect(youtubeOAuthConfig({ YOUTUBE_OAUTH_CLIENT_ID: 'id', YOUTUBE_OAUTH_CLIENT_SECRET: 's', PUBLIC_BASE_URL: 'https://test.linkeon.io/' }))
      .toEqual({ clientId: 'id', clientSecret: 's', redirectUri: 'https://test.linkeon.io/webhook/shorts/youtube/oauth/callback' });
  });

  it('без PUBLIC_BASE_URL — прод', () => {
    expect(youtubeOAuthConfig({ YOUTUBE_OAUTH_CLIENT_ID: 'id', YOUTUBE_OAUTH_CLIENT_SECRET: 's' })?.redirectUri)
      .toBe('https://my.linkeon.io/webhook/shorts/youtube/oauth/callback');
  });
});

describe('authorizeUrl', () => {
  it('offline, consent, оба scope и state', () => {
    const u = new URL(authorizeUrl(CFG, 'st.ate'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe(CFG.clientId);
    expect(u.searchParams.get('redirect_uri')).toBe(CFG.redirectUri);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')?.split(' ')).toEqual(YOUTUBE_SCOPES);
    expect(u.searchParams.get('state')).toBe('st.ate');
  });
});

describe('exchangeCode', () => {
  it('код → токены; запрос формой с секретом и адресом возврата', async () => {
    const { http, calls } = fakeHttp(reply(200, { access_token: 'at', refresh_token: 'rt', scope: 'a b' }));
    expect(await exchangeCode(http, CFG, 'code-1')).toEqual({ accessToken: 'at', refreshToken: 'rt', scope: 'a b' });
    const body = new URLSearchParams(calls[0].data);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://oauth2.googleapis.com/token' });
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('client_secret')).toBe('sec');
    expect(body.get('redirect_uri')).toBe(CFG.redirectUri);
  });

  it('нет refresh-токена — понятная ошибка', async () => {
    await expect(exchangeCode(fakeHttp(reply(200, { access_token: 'at' })).http, CFG, 'c')).rejects.toThrow(/refresh-токен/);
  });

  it('отказ Google — причина в ошибке', async () => {
    const { http } = fakeHttp(reply(400, { error: 'invalid_grant', error_description: 'Bad Request' }));
    await expect(exchangeCode(http, CFG, 'c')).rejects.toThrow('обмен кода: HTTP 400 invalid_grant: Bad Request');
  });
});

describe('refreshAccessToken', () => {
  it('свежий access-токен', async () => {
    const { http, calls } = fakeHttp(reply(200, { access_token: 'fresh' }));
    expect(await refreshAccessToken(http, CFG, 'rt')).toBe('fresh');
    expect(new URLSearchParams(calls[0].data).get('grant_type')).toBe('refresh_token');
  });

  it('invalid_grant — YoutubeAuthError с причиной', async () => {
    const { http } = fakeHttp(reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    await expect(refreshAccessToken(http, CFG, 'rt')).rejects.toThrow(new YoutubeAuthError('HTTP 400 invalid_grant: Token has been expired or revoked.'));
  });

  it('5xx и обрыв — YoutubeNotUploaded: до загрузки не дошло', async () => {
    await expect(refreshAccessToken(fakeHttp(reply(503, {})).http, CFG, 'rt')).rejects.toBeInstanceOf(YoutubeNotUploaded);
    await expect(refreshAccessToken(fakeHttp(new Error('ECONNRESET')).http, CFG, 'rt')).rejects.toBeInstanceOf(YoutubeNotUploaded);
  });
});

describe('fetchMyChannel', () => {
  it('канал с названием и псевдонимом', async () => {
    const { http, calls } = fakeHttp(reply(200, { items: [{ id: 'UCu_Pq4rFXmTT8CDG27O_i2A', snippet: { title: 'Linkeon', customUrl: '@linkeons' } }] }));
    expect(await fetchMyChannel(http, 'at')).toEqual({ id: 'UCu_Pq4rFXmTT8CDG27O_i2A', title: 'Linkeon', handle: '@linkeons' });
    expect(calls[0].headers?.Authorization).toBe('Bearer at');
    expect(calls[0].params).toEqual({ part: 'snippet', mine: 'true' });
  });

  it('у аккаунта нет канала — ошибка с подсказкой', async () => {
    await expect(fetchMyChannel(fakeHttp(reply(200, { items: [] })).http, 'at')).rejects.toThrow(/нет канала YouTube/);
  });
});
