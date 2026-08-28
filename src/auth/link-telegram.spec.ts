import * as crypto from 'crypto';
import { AuthController } from './auth.controller';

const BOT_TOKEN = '123456:TEST-TOKEN-AAAA';

function freshInitData(tgId = 42): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: tgId, first_name: 'Дмитрий', username: 'dv' }),
  };
  const dataCheckString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function mockRes() {
  const res: any = {};
  res.set = jest.fn(() => res);
  res.status = jest.fn((code: number) => { res._status = code; return res; });
  res.json = jest.fn((body: any) => { res._body = body; return res; });
  return res;
}

describe('POST /webhook/auth/identities/link/telegram', () => {
  let ctrl: any, identity: any, pg: any;

  beforeEach(() => {
    process.env.TG_BOT_TOKEN = BOT_TOKEN;
    identity = { linkMethod: jest.fn().mockResolvedValue({ ok: true }) };
    pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    // Прочие зависимости контроллера в этом сценарии не задействованы.
    // AuthController принимает 10 параметров, последний — pg (PgService).
    // Передаём его настоящим 10-м аргументом: сигнатура строго типизирована
    // и ts-jest роняет компиляцию на недостающем обязательном параметре —
    // «дописать реквизит после new» здесь не работает, как в исходном плане.
    ctrl = new AuthController(
      {} as any, {} as any, identity, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, pg,
    );
  });

  it('без JWT отвечает 401', async () => {
    const res = mockRes();
    await ctrl.linkTelegram({ initData: freshInitData() }, { user: undefined }, res);
    expect(res._status).toBe(401);
    expect(identity.linkMethod).not.toHaveBeenCalled();
  });

  it('битую подпись отвергает с 400 и не трогает базу', async () => {
    const res = mockRes();
    await ctrl.linkTelegram({ initData: 'hash=deadbeef' }, { user: { userId: 'u-1' } }, res);
    expect(res._status).toBe(400);
    expect(identity.linkMethod).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('привязывает Telegram к аккаунту и пишет строку в tg_user_identities', async () => {
    const res = mockRes();
    await ctrl.linkTelegram({ initData: freshInitData() }, { user: { userId: 'u-1' } }, res);
    expect(identity.linkMethod).toHaveBeenCalledWith('u-1', 'telegram', { sub: '42' });
    expect(pg.query.mock.calls[0][0]).toContain('INSERT INTO tg_user_identities');
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true });
  });

  it('чужой Telegram отдаёт 409 и не пишет в tg_user_identities', async () => {
    identity.linkMethod.mockResolvedValue({ ok: false, reason: 'conflict', conflictUserId: 'u-2' });
    const res = mockRes();
    await ctrl.linkTelegram({ initData: freshInitData() }, { user: { userId: 'u-1' } }, res);
    expect(res._status).toBe(409);
    expect(pg.query).not.toHaveBeenCalled();
  });
});
