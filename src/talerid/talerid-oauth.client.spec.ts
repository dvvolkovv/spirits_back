import { TalerIdOauthClient } from './talerid-oauth.client';

describe('TalerIdOauthClient', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      TALERID_BASE_URL: 'https://staging.id.taler.tirol',
      TALERID_PARTNER_SECRET: 'partner-secret-xyz',
      TALERID_CLIENT_ID: 'linkeon-partner',
      TALERID_CLIENT_SECRET: 'client-secret-abc',
    };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  function jsonResponse(status: number, body: any) {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: jest.fn().mockResolvedValue(body),
    } as any;
  }

  describe('provision', () => {
    it('200 → parses all fields and sends the request correctly (phone gets a leading +, x-partner-secret header present)', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: 'acc-1',
          refresh_token: 'ref-1',
          expires_in: 900,
          scope: 'mcp:calendar',
          talerid_user_id: 'tid-1',
        }),
      );
      const client = new TalerIdOauthClient(fetchMock);

      const result = await client.provision({
        phone: '79656445804', // no leading + — Linkeon stores it this way
        email: 'user@example.com',
        firstName: 'Dmitry',
        scopes: ['mcp:calendar'],
      });

      expect(result).toEqual({
        ok: true,
        taleridUserId: 'tid-1',
        accessToken: 'acc-1',
        refreshToken: 'ref-1',
        expiresIn: 900,
        scope: 'mcp:calendar',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://staging.id.taler.tirol/partner/provision');
      expect(init.method).toBe('POST');
      expect(init.headers['x-partner-secret']).toBe('partner-secret-xyz');

      const body = JSON.parse(init.body);
      expect(body.phone).toBe('+79656445804');
      expect(body.email).toBe('user@example.com');
      expect(body.firstName).toBe('Dmitry');
      expect(body.scopes).toEqual(['mcp:calendar']);
    });

    it('passes a phone through unchanged if it already has a leading +', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: 'acc-1',
          refresh_token: 'ref-1',
          expires_in: 900,
          scope: 'mcp:calendar',
          talerid_user_id: 'tid-1',
        }),
      );
      const client = new TalerIdOauthClient(fetchMock);

      await client.provision({ phone: '+79656445804', scopes: ['mcp:calendar'] });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.phone).toBe('+79656445804');
    });

    it('409 → {ok:false, kind:"ambiguous", status:409}', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(409, { error: 'ambiguous' }));
      const client = new TalerIdOauthClient(fetchMock);

      const result = await client.provision({ phone: '79656445804', scopes: ['mcp:calendar'] });

      expect(result).toEqual({ ok: false, kind: 'ambiguous', status: 409 });
    });

    it('401 → {ok:false, kind:"error", status:401}', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));
      const client = new TalerIdOauthClient(fetchMock);

      const result = await client.provision({ phone: '79656445804', scopes: ['mcp:calendar'] });

      expect(result).toEqual({ ok: false, kind: 'error', status: 401 });
    });

    it('500 → {ok:false, kind:"error", status:500}', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' }));
      const client = new TalerIdOauthClient(fetchMock);

      const result = await client.provision({ phone: '79656445804', scopes: ['mcp:calendar'] });

      expect(result).toEqual({ ok: false, kind: 'error', status: 500 });
    });

    it('network error → {ok:false, kind:"error"} (does not throw)', async () => {
      const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const client = new TalerIdOauthClient(fetchMock);

      const result = await client.provision({ phone: '79656445804', scopes: ['mcp:calendar'] });

      expect(result.ok).toBe(false);
      expect((result as any).kind).toBe('error');
    });
  });

  describe('refresh', () => {
    it('parses the new access AND new refresh, sends grant_type=refresh_token, Basic auth, and the narrowed scope', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 900,
          scope: 'mcp:calendar',
        }),
      );
      const client = new TalerIdOauthClient(fetchMock);

      const result = await client.refresh('old-refresh-token', ['mcp:calendar']);

      expect(result).toEqual({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 900,
        scope: 'mcp:calendar',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://staging.id.taler.tirol/oauth/token');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const expectedBasic = Buffer.from('linkeon-partner:client-secret-abc').toString('base64');
      expect(init.headers['Authorization']).toBe(`Basic ${expectedBasic}`);

      const params = new URLSearchParams(init.body);
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('old-refresh-token');
      expect(params.get('scope')).toBe('mcp:calendar');
    });

    it('throws on a non-2xx response', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));
      const client = new TalerIdOauthClient(fetchMock);

      await expect(client.refresh('bad-refresh', ['mcp:calendar'])).rejects.toThrow();
    });
  });

  describe('account linking (OAuth-link)', () => {
    beforeEach(() => {
      process.env.TALERID_WEB_CLIENT_ID = 'linkeon-partner-web';
      process.env.PUBLIC_BASE_URL = 'https://my.linkeon.io';
    });

    it('buildAuthorizeUrl → correct endpoint, public client, PKCE S256, registered redirect_uri', () => {
      const client = new TalerIdOauthClient(jest.fn());
      const url = new URL(client.buildAuthorizeUrl('st-1', 'chal-1'));
      expect(url.origin + url.pathname).toBe('https://staging.id.taler.tirol/oauth/auth');
      expect(url.searchParams.get('client_id')).toBe('linkeon-partner-web');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge')).toBe('chal-1');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBe('st-1');
      expect(url.searchParams.get('scope')).toBe('openid');
      expect(url.searchParams.get('redirect_uri')).toBe('https://my.linkeon.io/webhook/ecosystem/talerid/oauth/callback');
    });

    it('exchangeCodeForIdToken → sends code_verifier + NO client_secret (public), returns id_token', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { id_token: 'idt-1', access_token: 'a' }));
      const client = new TalerIdOauthClient(fetchMock);

      const idToken = await client.exchangeCodeForIdToken('code-1', 'verifier-1');

      expect(idToken).toBe('idt-1');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://staging.id.taler.tirol/oauth/token');
      const body = String(init.body);
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code_verifier=verifier-1');
      expect(body).toContain('client_id=linkeon-partner-web');
      expect(body).not.toContain('client_secret');
      expect(init.headers.Authorization).toBeUndefined(); // public client, no Basic auth
    });

    it('exchangeCodeForIdToken → throws on non-2xx and on missing id_token', async () => {
      const c1 = new TalerIdOauthClient(jest.fn().mockResolvedValue(jsonResponse(400, {})));
      await expect(c1.exchangeCodeForIdToken('c', 'v')).rejects.toThrow();
      const c2 = new TalerIdOauthClient(jest.fn().mockResolvedValue(jsonResponse(200, { access_token: 'a' })));
      await expect(c2.exchangeCodeForIdToken('c', 'v')).rejects.toThrow(/id_token/);
    });

    it('attachPhone 200 → ok with taleridUserId + merged; sends id_token, +E.164 phone, partner-secret', async () => {
      const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, {
        talerid_user_id: 'real-1', attached: true, merged: { notes: 2, calendar: 1, mail: 'moved', duplicate_deleted: true },
      }));
      const client = new TalerIdOauthClient(fetchMock);

      const r = await client.attachPhone('idt-1', '79656445804');

      expect(r).toEqual({ ok: true, taleridUserId: 'real-1', merged: { notes: 2, calendar: 1, mail: 'moved', duplicate_deleted: true } });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://staging.id.taler.tirol/partner/attach-phone');
      expect(init.headers['x-partner-secret']).toBe('partner-secret-xyz');
      expect(JSON.parse(init.body)).toEqual({ id_token: 'idt-1', phone: '+79656445804' });
    });

    it.each([
      ['account_has_different_phone', 'different_phone'],
      ['phone_belongs_to_another_account', 'phone_taken'],
      ['merge_has_messenger_data', 'has_messages'],
      ['something_else', 'error'],
    ])('attachPhone 409 error=%s → kind "%s"', async (code, kind) => {
      const client = new TalerIdOauthClient(jest.fn().mockResolvedValue(jsonResponse(409, { error: code })));
      expect(await client.attachPhone('idt', '79656445804')).toEqual({ ok: false, kind, status: 409 });
    });

    it('attachPhone 401 → invalid_login; network error → error/status 0', async () => {
      const c401 = new TalerIdOauthClient(jest.fn().mockResolvedValue(jsonResponse(401, {})));
      expect(await c401.attachPhone('idt', '7965')).toEqual({ ok: false, kind: 'invalid_login', status: 401 });
      const cNet = new TalerIdOauthClient(jest.fn().mockRejectedValue(new Error('ECONNRESET')));
      expect(await cNet.attachPhone('idt', '7965')).toEqual({ ok: false, kind: 'error', status: 0 });
    });
  });
});
