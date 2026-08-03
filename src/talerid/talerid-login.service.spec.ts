import { TalerIdLoginService } from './talerid-login.service';
import { createHash } from 'crypto';

/** Redis в памяти: сервис опирается на одноразовость ключей, её и проверяем. */
class FakeRedis {
  private store = new Map<string, string>();
  async set(k: string, v: string, _ttl?: number) { this.store.set(k, v); }
  async get(k: string) { return this.store.get(k) ?? null; }
  async del(k: string) { this.store.delete(k); }
}

const jwt = {
  signAccess: (u: string) => `access-for-${u}`,
  signRefresh: (u: string) => `refresh-for-${u}`,
} as any;

function makeService(overrides: {
  exchange?: (code: string, verifier: string) => Promise<any>;
  resolve?: (provider: string, data: any) => Promise<{ userId: string }>;
} = {}) {
  const redis = new FakeRedis();
  const client = {
    buildAuthorizeUrl: (state: string, challenge: string, scope?: string) =>
      `https://api.talerid.io/oauth/auth?state=${state}&code_challenge=${challenge}&scope=${encodeURIComponent(scope || 'openid')}`,
    exchangeCodeForUserinfo:
      overrides.exchange ??
      (async () => ({ sub: 'taler-sub-1', email: 'Someone@Example.io', emailVerified: true })),
  } as any;
  const identity = {
    resolveOrCreate: overrides.resolve ?? (async () => ({ userId: 'linkeon-user-1' })),
  } as any;
  return {
    svc: new TalerIdLoginService(client, redis as any, identity, jwt),
    redis,
    identity,
  };
}

/** Достаёт state из authorize-URL, как это сделал бы провайдер при возврате. */
function stateFrom(url: string): string {
  return new URL(url).searchParams.get('state')!;
}

describe('TalerIdLoginService', () => {
  it('просит scope email — иначе вернувшегося человека не узнать', async () => {
    const { svc } = makeService();
    const { authorizeUrl } = await svc.startLogin();
    const scope = new URL(authorizeUrl).searchParams.get('scope') ?? '';
    expect(scope.split(' ')).toContain('openid');
    // Без email вход завёл бы человеку второй аккаунт рядом с существующим.
    expect(scope.split(' ')).toContain('email');
  });

  it('challenge в ссылке — это S256 от сохранённого verifier', async () => {
    const { svc, redis } = makeService();
    const { authorizeUrl } = await svc.startLogin();
    const url = new URL(authorizeUrl);
    const state = url.searchParams.get('state')!;

    const raw = await redis.get(`talerid:login:${state}`);
    const { verifier } = JSON.parse(raw!);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
  });

  it('вход заводит identity через talerid и отдаёт код передачи', async () => {
    const seen: any[] = [];
    const { svc } = makeService({
      resolve: async (provider, data) => {
        seen.push({ provider, data });
        return { userId: 'linkeon-user-42' };
      },
    });

    const { authorizeUrl } = await svc.startLogin();
    const handoff = await svc.completeLogin(stateFrom(authorizeUrl), 'code-xyz');
    expect(handoff).toBeTruthy();

    expect(seen).toHaveLength(1);
    expect(seen[0].provider).toBe('talerid');
    expect(seen[0].data.sub).toBe('taler-sub-1');

    const tokens = await svc.redeemHandoff(handoff!);
    expect(tokens).toEqual({
      'access-token': 'access-for-linkeon-user-42',
      'refresh-token': 'refresh-for-linkeon-user-42',
    });
  });

  it('код передачи срабатывает один раз', async () => {
    const { svc } = makeService();
    const { authorizeUrl } = await svc.startLogin();
    const handoff = await svc.completeLogin(stateFrom(authorizeUrl), 'code-xyz');

    expect(await svc.redeemHandoff(handoff!)).toBeTruthy();
    // Повторный обмен не должен выдавать вторую сессию.
    expect(await svc.redeemHandoff(handoff!)).toBeNull();
  });

  it('повторный callback с тем же state сессию не выдаёт', async () => {
    const { svc } = makeService();
    const { authorizeUrl } = await svc.startLogin();
    const state = stateFrom(authorizeUrl);

    expect(await svc.completeLogin(state, 'code-1')).toBeTruthy();
    // state одноразовый — иначе перехваченный callback можно переиграть.
    expect(await svc.completeLogin(state, 'code-1')).toBeNull();
  });

  it('чужой state не проходит', async () => {
    const { svc } = makeService();
    expect(await svc.isLoginState('never-issued')).toBe(false);
    expect(await svc.completeLogin('never-issued', 'code')).toBeNull();
  });

  it('сбой обмена не выдаёт сессию', async () => {
    const { svc } = makeService({
      exchange: async () => {
        throw new Error('TalerID userinfo: no email (scope not granted?)');
      },
    });
    const { authorizeUrl } = await svc.startLogin();
    expect(await svc.completeLogin(stateFrom(authorizeUrl), 'code')).toBeNull();
  });

  it('state привязки не путается со state входа', async () => {
    const { svc, redis } = makeService();
    // Привязка кладёт свой ключ в другое пространство имён.
    await redis.set('talerid:link:abc', JSON.stringify({ userId: 'u', verifier: 'v', phone: '7' }));
    expect(await svc.isLoginState('abc')).toBe(false);
  });
});
