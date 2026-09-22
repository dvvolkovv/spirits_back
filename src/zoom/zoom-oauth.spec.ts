import { ZoomOauthClient } from './zoom-oauth.client';
import { ZoomOauthService } from './zoom-oauth.service';

/**
 * Подключение Zoom проверяем в двух самых опасных местах: адрес возврата и
 * ротация refresh-токена. Ошибка в первом отвергает вход целиком («redirect_uri
 * mismatch»), ошибка во втором разваливает подключение на ровном месте — Zoom
 * обесценивает прежний refresh при каждом обмене.
 */
describe('ZoomOauthClient', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ZOOM_SDK_CLIENT_ID = 'ключ';
    process.env.ZOOM_SDK_CLIENT_SECRET = 'секрет';
    process.env.PUBLIC_BASE_URL = 'https://my.linkeon.io';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('адрес возврата ведёт на нашу ручку и совпадает с зарегистрированным', () => {
    expect(new ZoomOauthClient().redirectUri())
      .toBe('https://my.linkeon.io/webhook/ecosystem/zoom/oauth/callback');
  });

  it('лишний слэш в базовом адресе не удваивается', () => {
    process.env.PUBLIC_BASE_URL = 'https://my.linkeon.io/';
    expect(new ZoomOauthClient().redirectUri())
      .toBe('https://my.linkeon.io/webhook/ecosystem/zoom/oauth/callback');
  });

  it('в адрес согласия уходят ключ, возврат и state', () => {
    const url = new URL(new ZoomOauthClient().authorizeUrl('состояние'));
    expect(url.origin + url.pathname).toBe('https://zoom.us/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('ключ');
    expect(url.searchParams.get('state')).toBe('состояние');
    expect(url.searchParams.get('redirect_uri')).toBe('https://my.linkeon.io/webhook/ecosystem/zoom/oauth/callback');
  });

  it('без ключей приложение считается ненастроенным', () => {
    delete process.env.ZOOM_SDK_CLIENT_ID;
    expect(new ZoomOauthClient().configured()).toBe(false);
  });
});

describe('ZoomOauthService', () => {
  const connection = () => ({
    userId: 'u1',
    zoomUserId: 'z1',
    zoomAccountId: 'a1',
    refreshToken: 'старый-refresh',
    accessToken: 'протухший',
    accessExpiresAt: new Date(Date.now() - 1000),
    scopes: 'user:read:user user:read:token',
  });

  it('обновляя токен, сохраняет НОВЫЙ refresh целиком', async () => {
    // Zoom ротирует refresh при каждом обмене: сохранить только access — значит
    // оставить в базе мёртвый refresh и потерять подключение на следующем входе.
    const store: any = { get: jest.fn().mockResolvedValue(connection()), save: jest.fn() };
    const client: any = {
      configured: () => true,
      refresh: jest.fn().mockResolvedValue({
        accessToken: 'новый-access',
        refreshToken: 'новый-refresh',
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: 'user:read:token',
      }),
      onBehalfToken: jest.fn().mockResolvedValue('обф'),
    };
    const svc = new ZoomOauthService(client, store);

    await expect(svc.obfToken('u1', '76639252685')).resolves.toBe('обф');
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      refreshToken: 'новый-refresh',
      accessToken: 'новый-access',
    }));
    expect(client.onBehalfToken).toHaveBeenCalledWith('новый-access', '76639252685');
  });

  it('два входа подряд обновляют токен один раз', async () => {
    // Иначе второй обмен пойдёт по уже обесцененному refresh и подключение
    // развалится ровно тогда, когда человек зовёт ассистента на две встречи.
    const store: any = { get: jest.fn().mockResolvedValue(connection()), save: jest.fn() };
    let calls = 0;
    const client: any = {
      configured: () => true,
      refresh: jest.fn().mockImplementation(async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), scopes: '' };
      }),
      onBehalfToken: jest.fn().mockResolvedValue('обф'),
    };
    const svc = new ZoomOauthService(client, store);

    await Promise.all([svc.obfToken('u1', '1'), svc.obfToken('u1', '2')]);
    expect(calls).toBe(1);
  });

  it('без подключения токена нет, и это не ошибка', async () => {
    const store: any = { get: jest.fn().mockResolvedValue(null), save: jest.fn() };
    const client: any = { configured: () => true, refresh: jest.fn(), onBehalfToken: jest.fn() };
    await expect(new ZoomOauthService(client, store).obfToken('u1', '1')).resolves.toBeNull();
    expect(client.onBehalfToken).not.toHaveBeenCalled();
  });

  it('отказ Zoom в выдаче токена не роняет вход', async () => {
    const store: any = {
      get: jest.fn().mockResolvedValue({ ...connection(), accessToken: 'живой', accessExpiresAt: new Date(Date.now() + 3600_000) }),
      save: jest.fn(),
    };
    const client: any = {
      configured: () => true,
      refresh: jest.fn(),
      onBehalfToken: jest.fn().mockRejectedValue(new Error('403')),
    };
    await expect(new ZoomOauthService(client, store).obfToken('u1', '1')).resolves.toBeNull();
  });
});
