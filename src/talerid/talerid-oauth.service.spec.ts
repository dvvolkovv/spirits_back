import { TalerIdOauthService } from './talerid-oauth.service';

describe('TalerIdOauthService', () => {
  function makeStore(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
      saveConnection: jest.fn().mockResolvedValue(undefined),
      updateRefresh: jest.fn().mockResolvedValue(undefined),
      updateAccess: jest.fn().mockResolvedValue(undefined),
      getConnection: jest.fn().mockResolvedValue(null),
      getRefresh: jest.fn().mockResolvedValue(null),
      getAccess: jest.fn().mockResolvedValue(null),
      setStatus: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any;
  }

  function makeClient(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
      provision: jest.fn(),
      refresh: jest.fn(),
      ...overrides,
    } as any;
  }

  describe('connect', () => {
    it('success → saveConnection called with the right fields + scope mcp:calendar, returns connected', async () => {
      const store = makeStore();
      const client = makeClient({
        provision: jest.fn().mockResolvedValue({
          ok: true,
          taleridUserId: 'tid-1',
          accessToken: 'acc-1',
          refreshToken: 'ref-1',
          expiresIn: 900,
          scope: 'mcp:calendar',
        }),
      });
      const service = new TalerIdOauthService(store, client);

      const before = Date.now();
      const result = await service.connect('user-1', '79656445804', 'a@b.com', 'Dmitry');
      const after = Date.now();

      expect(result).toBe('connected');
      expect(client.provision).toHaveBeenCalledWith({
        phone: '79656445804',
        email: 'a@b.com',
        firstName: 'Dmitry',
        scopes: ['mcp:calendar'],
      });
      expect(store.saveConnection).toHaveBeenCalledTimes(1);
      const [userId, params] = store.saveConnection.mock.calls[0];
      expect(userId).toBe('user-1');
      expect(params.taleridUserId).toBe('tid-1');
      expect(params.refreshToken).toBe('ref-1');
      expect(params.accessToken).toBe('acc-1');
      expect(params.scopes).toBe('mcp:calendar');
      expect(params.accessExpiresAt).toBeInstanceOf(Date);
      const expiresAtMs = params.accessExpiresAt.getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 900 * 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 900 * 1000);
      expect(store.setStatus).not.toHaveBeenCalled();
    });

    it('ambiguous → setStatus("ambiguous"), no saveConnection, returns ambiguous', async () => {
      const store = makeStore();
      const client = makeClient({
        provision: jest.fn().mockResolvedValue({ ok: false, kind: 'ambiguous', status: 409 }),
      });
      const service = new TalerIdOauthService(store, client);

      const result = await service.connect('user-1', '79656445804');

      expect(result).toBe('ambiguous');
      expect(store.setStatus).toHaveBeenCalledWith('user-1', 'ambiguous');
      expect(store.saveConnection).not.toHaveBeenCalled();
    });

    it('error → setStatus("error"), no saveConnection, returns error', async () => {
      const store = makeStore();
      const client = makeClient({
        provision: jest.fn().mockResolvedValue({ ok: false, kind: 'error', status: 500 }),
      });
      const service = new TalerIdOauthService(store, client);

      const result = await service.connect('user-1', '79656445804');

      expect(result).toBe('error');
      expect(store.setStatus).toHaveBeenCalledWith('user-1', 'error');
      expect(store.saveConnection).not.toHaveBeenCalled();
    });
  });

  describe('getBackendAccessToken', () => {
    it('not connected → null', async () => {
      const store = makeStore({ getConnection: jest.fn().mockResolvedValue(null) });
      const client = makeClient();
      const service = new TalerIdOauthService(store, client);

      const result = await service.getBackendAccessToken('user-1');

      expect(result).toBeNull();
      expect(client.refresh).not.toHaveBeenCalled();
    });

    it('status !== connected → null', async () => {
      const store = makeStore({
        getConnection: jest.fn().mockResolvedValue({
          userId: 'user-1',
          taleridUserId: 'tid-1',
          scopes: 'mcp:calendar',
          status: 'ambiguous',
        }),
      });
      const client = makeClient();
      const service = new TalerIdOauthService(store, client);

      const result = await service.getBackendAccessToken('user-1');

      expect(result).toBeNull();
      expect(client.refresh).not.toHaveBeenCalled();
    });

    it('fresh stored access → returns it WITHOUT calling refresh', async () => {
      const farFuture = new Date(Date.now() + 10 * 60 * 1000);
      const store = makeStore({
        getConnection: jest.fn().mockResolvedValue({
          userId: 'user-1',
          taleridUserId: 'tid-1',
          scopes: 'mcp:calendar',
          status: 'connected',
          accessExpiresAt: farFuture,
        }),
        getAccess: jest.fn().mockResolvedValue({ accessToken: 'fresh-access', expiresAt: farFuture }),
      });
      const client = makeClient();
      const service = new TalerIdOauthService(store, client);

      const result = await service.getBackendAccessToken('user-1');

      expect(result).toBe('fresh-access');
      expect(client.refresh).not.toHaveBeenCalled();
      expect(store.updateRefresh).not.toHaveBeenCalled();
      expect(store.updateAccess).not.toHaveBeenCalled();
    });

    it('expired/absent access → calls refresh, persists rotated refresh + new access, returns new access', async () => {
      const pastExpiry = new Date(Date.now() - 60 * 1000);
      const store = makeStore({
        getConnection: jest.fn().mockResolvedValue({
          userId: 'user-1',
          taleridUserId: 'tid-1',
          scopes: 'mcp:calendar',
          status: 'connected',
          accessExpiresAt: pastExpiry,
        }),
        getAccess: jest.fn().mockResolvedValue({ accessToken: 'stale-access', expiresAt: pastExpiry }),
        getRefresh: jest.fn().mockResolvedValue('old-refresh'),
      });
      const client = makeClient({
        refresh: jest.fn().mockResolvedValue({
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresIn: 900,
          scope: 'mcp:calendar',
        }),
      });
      const service = new TalerIdOauthService(store, client);

      const result = await service.getBackendAccessToken('user-1');

      expect(client.refresh).toHaveBeenCalledWith('old-refresh', ['mcp:calendar']);
      expect(store.updateRefresh).toHaveBeenCalledWith('user-1', 'new-refresh');
      expect(store.updateAccess).toHaveBeenCalledWith('user-1', 'new-access', expect.any(Date));
      expect(result).toBe('new-access');

      // rotation persistence must happen before returning, i.e. both calls actually made
      expect(store.updateRefresh).toHaveBeenCalledTimes(1);
      expect(store.updateAccess).toHaveBeenCalledTimes(1);
    });

    it('no stored access at all (absent) → calls refresh and returns new access', async () => {
      const store = makeStore({
        getConnection: jest.fn().mockResolvedValue({
          userId: 'user-1',
          taleridUserId: 'tid-1',
          scopes: 'mcp:calendar',
          status: 'connected',
        }),
        getAccess: jest.fn().mockResolvedValue(null),
        getRefresh: jest.fn().mockResolvedValue('old-refresh'),
      });
      const client = makeClient({
        refresh: jest.fn().mockResolvedValue({
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresIn: 900,
          scope: 'mcp:calendar',
        }),
      });
      const service = new TalerIdOauthService(store, client);

      const result = await service.getBackendAccessToken('user-1');

      expect(result).toBe('new-access');
      expect(store.updateRefresh).toHaveBeenCalledWith('user-1', 'new-refresh');
    });

    it('refresh throws → null (no crash)', async () => {
      const pastExpiry = new Date(Date.now() - 60 * 1000);
      const store = makeStore({
        getConnection: jest.fn().mockResolvedValue({
          userId: 'user-1',
          taleridUserId: 'tid-1',
          scopes: 'mcp:calendar',
          status: 'connected',
          accessExpiresAt: pastExpiry,
        }),
        getAccess: jest.fn().mockResolvedValue({ accessToken: 'stale-access', expiresAt: pastExpiry }),
        getRefresh: jest.fn().mockResolvedValue('old-refresh'),
      });
      const client = makeClient({
        refresh: jest.fn().mockRejectedValue(new Error('TalerID refresh failed: HTTP 400')),
      });
      const service = new TalerIdOauthService(store, client);

      const result = await service.getBackendAccessToken('user-1');

      expect(result).toBeNull();
      expect(store.updateRefresh).not.toHaveBeenCalled();
      expect(store.updateAccess).not.toHaveBeenCalled();
    });

    it('no refresh token stored → null (no refresh call)', async () => {
      const store = makeStore({
        getConnection: jest.fn().mockResolvedValue({
          userId: 'user-1',
          taleridUserId: 'tid-1',
          scopes: 'mcp:calendar',
          status: 'connected',
        }),
        getAccess: jest.fn().mockResolvedValue(null),
        getRefresh: jest.fn().mockResolvedValue(null),
      });
      const client = makeClient();
      const service = new TalerIdOauthService(store, client);

      const result = await service.getBackendAccessToken('user-1');

      expect(result).toBeNull();
      expect(client.refresh).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('calls store.delete', async () => {
      const store = makeStore();
      const client = makeClient();
      const service = new TalerIdOauthService(store, client);

      await service.disconnect('user-1');

      expect(store.delete).toHaveBeenCalledWith('user-1');
    });
  });
});
