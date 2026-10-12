import * as fs from 'fs';
import * as path from 'path';
import { AuthController } from './auth.controller';
import { JwtService } from '../common/services/jwt.service';
import { signProductToolToken } from '../products/product-tool.token';

/**
 * Привязать новый способ входа к аккаунту и открыть голосовой канал можно
 * только ТОКЕНОМ ДОСТУПА. Тем же секретом подписаны токены обновления и
 * токены инструмента продуктов, а последние бэк отдаёт релею на время хода
 * (30 минут, в Telegram 2 часа), где их видят и чужие сессии. Без проверки
 * типа такой токен годился бы, чтобы привязать к чужому аккаунту свой Google
 * и войти в него.
 */
process.env.JWT_SECRET = 'link-token-type-spec-secret';
const jwt = new JwtService();

const notAccess: Array<[string, () => string]> = [
  ['обновления', () => jwt.signRefresh('u-1')],
  ['инструмента продуктов', () => signProductToolToken('u-1')],
  ['инструмента продуктов из Telegram', () => signProductToolToken('u-1', 'telegram')],
];

function mockRes() {
  const res: any = {};
  res.set = jest.fn(() => res);
  res.status = jest.fn((code: number) => { res._status = code; return res; });
  res.json = jest.fn((body: any) => { res._body = body; return res; });
  return res;
}

function makeCtrl() {
  const identity = { linkMethod: jest.fn().mockResolvedValue({ ok: true }) };
  const redis = { set: jest.fn().mockResolvedValue(undefined) };
  const google = { buildAuthorizeUrl: jest.fn(() => 'https://accounts.example/authorize') };
  const apple = {
    verifyIdentityToken: jest.fn().mockResolvedValue({ sub: 'apple-sub', email: 'a@example.com', emailVerified: true }),
  };
  const ctrl = new AuthController(
    {} as any, {} as any, identity as any, jwt, redis as any,
    google as any, {} as any, apple as any, {} as any, {} as any,
  );
  return { ctrl, identity, redis };
}

const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

describe('JwtService.verifyAccess', () => {
  it('принимает токен доступа', () => {
    expect(jwt.verifyAccess(jwt.signAccess('u-1')).userId).toBe('u-1');
  });

  it.each(notAccess)('отвергает токен %s', (_name, make) => {
    expect(() => jwt.verifyAccess(make())).toThrow();
  });
});

describe('привязка Google/Яндекса: POST auth/oauth/init, intent=link', () => {
  it.each(notAccess)('токен %s — 401, привязка не начинается', async (_name, make) => {
    const { ctrl, redis } = makeCtrl();
    const res = mockRes();
    await ctrl.oauthInit({ provider: 'google', intent: 'link' }, bearer(make()), res);
    expect(res._status).toBe(401);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('токен доступа — привязка к его владельцу', async () => {
    const { ctrl, redis } = makeCtrl();
    const res = mockRes();
    await ctrl.oauthInit({ provider: 'google', intent: 'link' }, bearer(jwt.signAccess('u-1')), res);
    expect(res._status).toBe(200);
    expect(JSON.parse(redis.set.mock.calls[0][1]).userId).toBe('u-1');
  });
});

describe('привязка Apple: POST auth/apple/native с Bearer', () => {
  it.each(notAccess)('токен %s — 401, к аккаунту ничего не привязано', async (_name, make) => {
    const { ctrl, identity } = makeCtrl();
    const res = mockRes();
    await ctrl.appleNative({ identityToken: 'apple-id-token' }, bearer(make()), res);
    expect(res._status).toBe(401);
    expect(identity.linkMethod).not.toHaveBeenCalled();
  });

  it('токен доступа — Apple привязывается к его владельцу', async () => {
    const { ctrl, identity } = makeCtrl();
    const res = mockRes();
    await ctrl.appleNative({ identityToken: 'apple-id-token' }, bearer(jwt.signAccess('u-1')), res);
    expect(res._status).toBe(200);
    expect(identity.linkMethod).toHaveBeenCalledWith('u-1', 'apple', expect.anything());
  });
});

describe('голосовой WebSocket', () => {
  // attachVoiceWs вешается на HTTP-сервер Nest; поднимать его ради одной
  // проверки дорого, поэтому сторожим исходник.
  const src = fs.readFileSync(path.join(__dirname, '../voice/voice-ws.ts'), 'utf8');

  it('пускает только по токену доступа', () => {
    expect(src).toContain('jwt.verifyAccess(token)');
    expect(src).not.toMatch(/jwt\.verify\(token\)/);
  });
});
