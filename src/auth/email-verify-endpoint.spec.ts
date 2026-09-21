import { AuthController } from './auth.controller';

/**
 * GET /webhook/auth/email/verify — вторая половина подтверждения анкетной
 * почты. Ссылка приходит в письме после оплаты и делает адрес настоящей
 * связкой входа.
 *
 * Эндпоинт ПУБЛИЧНЫЙ, без JwtGuard, и это не упущение: письмо открывают в
 * почтовом клиенте на телефоне, а вошли в Linkeon в браузере на ноутбуке.
 * Требовать JWT здесь значило бы, что подтверждение работает лишь у тех, кто
 * читает почту в том же браузере. Владение аккаунтом доказано иначе — userId
 * лежит внутри одноразового токена, который мы сами положили в Redis, когда
 * человек был авторизован.
 */

function mockRes() {
  const res: any = { _status: 0, _body: null, _redirect: null };
  res.status = (s: number) => { res._status = s; return res; };
  res.json = (b: any) => { res._body = b; return res; };
  res.set = () => res;
  res.type = () => res;
  res.send = (b: any) => { res._body = b; return res; };
  res.redirect = (u: string) => { res._redirect = u; return res; };
  return res;
}

function makeController(over: any = {}) {
  const email = {
    consumeVerifyToken: jest.fn().mockResolvedValue({ userId: 'u-1', email: 'buyer@mail.ru' }),
    ...over.email,
  };
  const identity = {
    linkMethod: jest.fn().mockResolvedValue({ ok: true }),
    ...over.identity,
  };
  const ctrl = Object.create(AuthController.prototype) as any;
  ctrl.email = email;
  ctrl.identity = identity;
  ctrl.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { ctrl, email, identity };
}

describe('GET /webhook/auth/email/verify', () => {
  it('делает почту способом входа для userId из токена', async () => {
    const { ctrl, identity } = makeController();
    const res = mockRes();

    await ctrl.emailVerify('vtok', res);

    expect(identity.linkMethod).toHaveBeenCalledWith('u-1', 'email', { email: 'buyer@mail.ru' });
    expect(res._status).toBe(200);
  });

  it('протухший токен связку не создаёт', async () => {
    const { ctrl, identity } = makeController({
      email: { consumeVerifyToken: jest.fn().mockResolvedValue(null) },
    });
    const res = mockRes();

    await ctrl.emailVerify('stale', res);

    expect(identity.linkMethod).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });

  it('пустой токен связку не создаёт', async () => {
    const { ctrl, identity } = makeController();
    const res = mockRes();

    await ctrl.emailVerify('', res);

    expect(identity.linkMethod).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });

  it('адрес, успевший стать входом другого аккаунта, не перевешивается', async () => {
    // Между письмом и кликом тот же адрес мог быть подтверждён в другом
    // аккаунте. linkMethod вернёт conflict — молча показать «готово» нельзя.
    const { ctrl } = makeController({
      identity: { linkMethod: jest.fn().mockResolvedValue({ ok: false, reason: 'conflict', conflictUserId: 'u-2' }) },
    });
    const res = mockRes();

    await ctrl.emailVerify('vtok', res);

    expect(res._status).toBe(409);
  });
});
