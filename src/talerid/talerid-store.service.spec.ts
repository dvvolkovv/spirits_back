import { decryptSecret } from '../calendar/crypto';
import { TalerIdStoreService } from './talerid-store.service';

describe('TalerIdStoreService', () => {
  beforeAll(() => {
    process.env.CALENDAR_SECRET_KEY = '0123456789abcdef0123456789abcdef';
  });

  function makePg(rows: any[] = []) {
    return { query: jest.fn().mockResolvedValue({ rows }) };
  }

  describe('encryption round-trip (saveConnection → getRefresh)', () => {
    it('never sends the plaintext refresh token to pg, and getRefresh decrypts it back to the original', async () => {
      const pg = makePg();
      const store = new TalerIdStoreService(pg as any);

      await store.saveConnection('u1', {
        taleridUserId: 'tid-1',
        refreshToken: 'super-secret-refresh',
        accessToken: 'super-secret-access',
        accessExpiresAt: new Date('2026-07-25T12:00:00Z'),
        scopes: 'mcp:calendar',
      });

      expect(pg.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toContain('talerid_connections');
      // The plaintext must never appear anywhere in the query params sent to pg.
      const paramsStr = JSON.stringify(params);
      expect(paramsStr).not.toContain('super-secret-refresh');
      expect(paramsStr).not.toContain('super-secret-access');

      // Find the encrypted refresh token among the params and confirm it decrypts back.
      const encRefresh = params.find((p: any) => typeof p === 'string' && p.includes(':') && decryptSecretSafe(p) === 'super-secret-refresh');
      expect(encRefresh).toBeTruthy();

      // Now simulate a read: getRefresh queries pg and decrypts the stored value.
      const pg2 = makePg([{ refresh_token_enc: encRefresh }]);
      const store2 = new TalerIdStoreService(pg2 as any);
      const refresh = await store2.getRefresh('u1');
      expect(refresh).toBe('super-secret-refresh');
      expect(pg2.query.mock.calls[0][1]).toEqual(['u1']);
    });

    function decryptSecretSafe(v: string): string | null {
      try { return decryptSecret(v); } catch { return null; }
    }
  });

  describe('updateRefresh — atomic overwrite (rotation)', () => {
    it('overwrites the stored refresh with a newly-encrypted value', async () => {
      const pg = makePg();
      const store = new TalerIdStoreService(pg as any);

      await store.updateRefresh('u1', 'brand-new-refresh');

      expect(pg.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toContain('UPDATE talerid_connections');
      expect(sql).toContain('refresh_token_enc');
      expect(params[0]).toBe('u1');
      const encParam = params.find((p: any) => typeof p === 'string' && p.includes(':'));
      expect(encParam).not.toContain('brand-new-refresh');
      expect(decryptSecret(encParam)).toBe('brand-new-refresh');
    });
  });

  describe('user-scoping', () => {
    it('getConnection scopes the query to the passed userId only', async () => {
      const pg = makePg([
        { user_id: 'u1', talerid_user_id: 'tid-1', scopes: 'mcp:calendar', status: 'connected', access_expires_at: null },
      ]);
      const store = new TalerIdStoreService(pg as any);

      const conn = await store.getConnection('u1');

      expect(pg.query.mock.calls[0][1]).toEqual(['u1']);
      expect(conn).toEqual({
        userId: 'u1',
        taleridUserId: 'tid-1',
        scopes: 'mcp:calendar',
        status: 'connected',
        accessExpiresAt: undefined,
      });
    });

    it('getRefresh scopes the query to the passed userId only', async () => {
      const pg = makePg([]);
      const store = new TalerIdStoreService(pg as any);

      const refresh = await store.getRefresh('userB');

      expect(refresh).toBeNull();
      expect(pg.query.mock.calls[0][1]).toEqual(['userB']);
      // Never leaks another user's id into the query params.
      expect(pg.query).not.toHaveBeenCalledWith(expect.anything(), ['79656445804']);
    });

    it('getConnection returns null when no row exists for that user', async () => {
      const pg = makePg([]);
      const store = new TalerIdStoreService(pg as any);

      expect(await store.getConnection('nobody')).toBeNull();
    });
  });

  describe('getAccess', () => {
    it('decrypts the stored access token', async () => {
      const { encryptSecret } = require('../calendar/crypto');
      const enc = encryptSecret('the-access-token');
      const expiresAt = new Date('2026-07-25T12:00:00Z');
      const pg = makePg([{ access_token_enc: enc, access_expires_at: expiresAt }]);
      const store = new TalerIdStoreService(pg as any);

      const access = await store.getAccess('u1');

      expect(access).toEqual({ accessToken: 'the-access-token', expiresAt });
      expect(pg.query.mock.calls[0][1]).toEqual(['u1']);
    });

    it('returns null when there is no access token stored', async () => {
      const pg = makePg([{ access_token_enc: null, access_expires_at: null }]);
      const store = new TalerIdStoreService(pg as any);

      expect(await store.getAccess('u1')).toBeNull();
    });
  });

  describe('setStatus', () => {
    it('upserts the status scoped to the userId', async () => {
      const pg = makePg();
      const store = new TalerIdStoreService(pg as any);

      await store.setStatus('u1', 'ambiguous');

      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toContain('talerid_connections');
      expect(params).toEqual(['u1', 'ambiguous']);
    });
  });

  describe('delete', () => {
    it('deletes only the given user row', async () => {
      const pg = makePg();
      const store = new TalerIdStoreService(pg as any);

      await store.delete('u1');

      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toContain('DELETE FROM talerid_connections');
      expect(params).toEqual(['u1']);
    });
  });
});
