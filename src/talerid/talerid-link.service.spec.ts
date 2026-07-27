import { TalerIdLinkService } from './talerid-link.service';

/** In-memory Redis double. */
function makeRedis(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    del: jest.fn(async (k: string) => { store.delete(k); }),
  } as any;
}
function makeClient(over: any = {}) {
  return {
    buildAuthorizeUrl: jest.fn((state: string, challenge: string) => `https://talerid/oauth/auth?state=${state}&code_challenge=${challenge}`),
    exchangeCodeForIdToken: jest.fn(async () => 'id-token-xyz'),
    attachPhone: jest.fn(async () => ({ ok: true, taleridUserId: 'real-acct-1', merged: {} })),
    ...over,
  } as any;
}
function makeOauth(over: any = {}) {
  return { connect: jest.fn(async () => 'connected'), ...over } as any;
}

describe('TalerIdLinkService', () => {
  describe('startLink', () => {
    it('stashes {userId,verifier,phone} in Redis with TTL and returns an authorize URL', async () => {
      const redis = makeRedis();
      const client = makeClient();
      const svc = new TalerIdLinkService(client, makeOauth(), redis);

      const { authorizeUrl } = await svc.startLink('user-1', '79656445804');

      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, value, ttl] = redis.set.mock.calls[0];
      expect(key).toMatch(/^talerid:link:/);
      const stashed = JSON.parse(value);
      expect(stashed).toEqual({ userId: 'user-1', verifier: expect.any(String), phone: '79656445804' });
      expect(stashed.verifier.length).toBeGreaterThanOrEqual(43); // PKCE min
      expect(ttl).toBe(1800);
      // Authorize URL carries the S256 challenge derived from the (server-only) verifier, not the verifier.
      expect(authorizeUrl).toContain('code_challenge=');
      expect(authorizeUrl).not.toContain(stashed.verifier);
      expect(client.buildAuthorizeUrl).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    });
  });

  describe('completeLink', () => {
    const state = 'st-1';
    const seedState = (over: any = {}) => makeRedis({
      [`talerid:link:${state}`]: JSON.stringify({ userId: 'user-1', verifier: 'ver-1', phone: '79656445804', ...over }),
    });

    it('happy path → exchange, attach, provision → "linked" (state consumed one-time)', async () => {
      const redis = seedState();
      const client = makeClient();
      const oauth = makeOauth();
      const svc = new TalerIdLinkService(client, oauth, redis);

      const result = await svc.completeLink(state, 'code-1');

      expect(result).toBe('linked');
      expect(client.exchangeCodeForIdToken).toHaveBeenCalledWith('code-1', 'ver-1');
      expect(client.attachPhone).toHaveBeenCalledWith('id-token-xyz', '79656445804');
      expect(oauth.connect).toHaveBeenCalledWith('user-1', '79656445804');
      expect(redis.del).toHaveBeenCalledWith(`talerid:link:${state}`); // one-time use
    });

    it('missing/expired state → "expired", no exchange', async () => {
      const client = makeClient();
      const svc = new TalerIdLinkService(client, makeOauth(), makeRedis());
      const result = await svc.completeLink('nope', 'code-1');
      expect(result).toBe('expired');
      expect(client.exchangeCodeForIdToken).not.toHaveBeenCalled();
    });

    it('empty state/code → "error"', async () => {
      const svc = new TalerIdLinkService(makeClient(), makeOauth(), seedState());
      expect(await svc.completeLink('', 'code-1')).toBe('error');
      expect(await svc.completeLink(state, '')).toBe('error');
    });

    it('code exchange throws → "error", state already consumed', async () => {
      const redis = seedState();
      const client = makeClient({ exchangeCodeForIdToken: jest.fn(async () => { throw new Error('bad code'); }) });
      const svc = new TalerIdLinkService(client, makeOauth(), redis);
      expect(await svc.completeLink(state, 'code-1')).toBe('error');
      expect(client.attachPhone).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalled();
    });

    it.each([
      ['different_phone', 'different_phone'],
      ['phone_taken', 'phone_taken'],
      ['has_messages', 'has_messages'],
      ['invalid_login', 'error'],
      ['error', 'error'],
    ])('attach fail kind=%s → status "%s", no provision', async (kind, expected) => {
      const redis = seedState();
      const oauth = makeOauth();
      const client = makeClient({ attachPhone: jest.fn(async () => ({ ok: false, kind, status: 409 })) });
      const svc = new TalerIdLinkService(client, oauth, redis);
      expect(await svc.completeLink(state, 'code-1')).toBe(expected);
      expect(oauth.connect).not.toHaveBeenCalled();
    });

    it('attach ok but provision not "connected" → "error"', async () => {
      const svc = new TalerIdLinkService(makeClient(), makeOauth({ connect: jest.fn(async () => 'ambiguous') }), seedState());
      expect(await svc.completeLink(state, 'code-1')).toBe('error');
    });
  });
});
