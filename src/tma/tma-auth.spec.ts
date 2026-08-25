import * as crypto from 'crypto';
import { TmaController } from './tma.controller';

const BOT_TOKEN = '123456:TEST-TOKEN-AAAA';

function signInitData(fields: Record<string, string>): string {
  const dataCheckString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const freshInitData = (tgId = 42) =>
  signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: tgId, first_name: 'Дмитрий', username: 'dv' }),
  });

function mockRes() {
  const res: any = {};
  res.set = jest.fn(() => res);
  res.status = jest.fn((code: number) => { res._status = code; return res; });
  res.json = jest.fn((body: any) => { res._body = body; return res; });
  return res;
}

describe('POST /webhook/tma/auth', () => {
  let pg: any, identity: any, jwt: any, ctrl: TmaController;

  beforeEach(() => {
    process.env.TG_BOT_TOKEN = BOT_TOKEN;
    pg = { query: jest.fn().mockResolvedValue({ rows: [] }), getClient: jest.fn() };
    identity = { resolveOrCreate: jest.fn() };
    jwt = { signAccess: jest.fn(() => 'ACC'), signRefresh: jest.fn(() => 'REF') };
    ctrl = new TmaController(pg, identity, jwt);
  });

  it('отвергает битую подпись с 401', async () => {
    const res = mockRes();
    await ctrl.auth({ initData: 'user=%7B%22id%22%3A1%7D&hash=deadbeef' }, res);
    expect(res._status).toBe(401);
    expect(identity.resolveOrCreate).not.toHaveBeenCalled();
  });

  it('незнакомому tg_user_id без intent отдаёт 404 needsChoice', async () => {
    const res = mockRes();
    await ctrl.auth({ initData: freshInitData() }, res);
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ needsChoice: true });
    expect(identity.resolveOrCreate).not.toHaveBeenCalled();
  });

  it('с intent=signup заводит аккаунт и отдаёт пару токенов', async () => {
    identity.resolveOrCreate.mockResolvedValue({ userId: 'u-new', isNew: true, mergedExisting: false });
    const res = mockRes();
    await ctrl.auth({ initData: freshInitData(), intent: 'signup' }, res);
    expect(identity.resolveOrCreate).toHaveBeenCalledWith('telegram', { sub: '42' });
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ 'access-token': 'ACC', 'refresh-token': 'REF' });
  });

  it('находит пользователя по user_identities и не заводит нового', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ user_id: 'u-known' }] });
    const res = mockRes();
    await ctrl.auth({ initData: freshInitData() }, res);
    expect(identity.resolveOrCreate).not.toHaveBeenCalled();
    expect(jwt.signAccess).toHaveBeenCalledWith('u-known');
    expect(res._status).toBe(200);
  });

  it('находит старожила бота по tg_user_identities и дописывает строку в user_identities', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [] })                              // user_identities — пусто
      .mockResolvedValueOnce({ rows: [{ linkeon_user_id: 'u-bot' }] })  // tg_user_identities — есть
      .mockResolvedValueOnce({ rows: [] });                             // бэкфилл INSERT
    const res = mockRes();
    await ctrl.auth({ initData: freshInitData() }, res);
    expect(res._status).toBe(200);
    expect(jwt.signAccess).toHaveBeenCalledWith('u-bot');
    const backfill = pg.query.mock.calls[2][0];
    expect(backfill).toContain('INSERT INTO user_identities');
  });
});
