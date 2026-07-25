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
});
