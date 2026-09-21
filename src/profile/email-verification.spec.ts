import { ProfileController } from './profile.controller';

/**
 * Анкетная почта должна уметь становиться способом входа.
 *
 * Корень инцидента 19.09.2026 оказался не в профиле: `POST /webhook/set-email`
 * зовут ФОРМЫ ОПЛАТЫ (TokenPackages, TokenPurchasePage) — адрес собирается для
 * чека YooKassa. Человек вводит почту, покупая токены, и совершенно разумно
 * считает, что теперь по ней можно войти. А она ложится в
 * ai_profiles_consolidated.email, которая входом не является.
 *
 * Шаг 2 научил вход останавливаться и предлагать привязку. Здесь — вторая
 * половина: после оплаты уходит письмо, по которому почта становится
 * настоящей связкой, и до развилки дело уже не доходит.
 */

function mockRes() {
  const res: any = { _status: 0, _body: null };
  res.status = (s: number) => { res._status = s; return res; };
  res.json = (b: any) => { res._body = b; return res; };
  res.set = () => res;
  res.type = () => res;
  res.send = (b: any) => { res._body = b; return res; };
  return res;
}

function makeController(over: any = {}) {
  const profileService = { setEmail: jest.fn().mockResolvedValue({ success: true }), ...over.profileService };
  const email = {
    isTempmail: jest.fn().mockReturnValue(false),
    generateVerifyToken: jest.fn().mockResolvedValue('vtok'),
    sendVerifyEmail: jest.fn().mockResolvedValue(undefined),
    ...over.email,
  };
  const identity = {
    listIdentities: jest.fn().mockResolvedValue([]),
    findIdentityByEmail: jest.fn().mockResolvedValue(null),
    ...over.identity,
  };
  const ctrl = new ProfileController(profileService as any, null as any, email as any, identity as any);
  return { ctrl, profileService, email, identity };
}

describe('POST /webhook/set-email — почта из формы оплаты', () => {
  it('сохраняет адрес и зовёт подтверждение', async () => {
    const { ctrl, profileService, email } = makeController();
    const res = mockRes();

    await ctrl.setEmail({ userId: 'u-1' }, { email: 'Buyer@Mail.RU' }, res);

    expect(res._status).toBe(200);
    expect(profileService.setEmail).toHaveBeenCalledWith('u-1', 'Buyer@Mail.RU');
    expect(email.generateVerifyToken).toHaveBeenCalledWith('u-1', 'buyer@mail.ru');
    expect(email.sendVerifyEmail).toHaveBeenCalledWith('buyer@mail.ru', 'vtok');
  });

  it('не шлёт письмо, если эта почта уже вход этого же человека', async () => {
    // Иначе письмо «подтвердите почту» уходило бы на КАЖДУЮ покупку.
    const { ctrl, email } = makeController({
      identity: {
        listIdentities: jest.fn().mockResolvedValue([
          { provider: 'email', email: 'buyer@mail.ru', emailVerified: true },
        ]),
      },
    });
    const res = mockRes();

    await ctrl.setEmail({ userId: 'u-1' }, { email: 'buyer@mail.ru' }, res);

    expect(res._status).toBe(200);
    expect(email.sendVerifyEmail).not.toHaveBeenCalled();
  });

  it('не шлёт письмо, если адрес — вход ДРУГОГО аккаунта', async () => {
    // Подтверждать нечего: привязка всё равно упрётся в conflict, а письмо
    // выглядело бы как приглашение зайти в чужой аккаунт.
    const { ctrl, email } = makeController({
      identity: { findIdentityByEmail: jest.fn().mockResolvedValue({ userId: 'someone-else' }) },
    });
    const res = mockRes();

    await ctrl.setEmail({ userId: 'u-1' }, { email: 'buyer@mail.ru' }, res);

    expect(res._status).toBe(200);
    expect(email.sendVerifyEmail).not.toHaveBeenCalled();
  });

  it('упавшая отправка НЕ роняет set-email', async () => {
    // Это путь оплаты. Уронить его из-за недоступного SMTP значит не продать
    // токены — цена несоизмерима с непосланным письмом.
    const { ctrl, profileService } = makeController({
      email: { sendVerifyEmail: jest.fn().mockRejectedValue(new Error('SMTP down')) },
    });
    const res = mockRes();

    await ctrl.setEmail({ userId: 'u-1' }, { email: 'buyer@mail.ru' }, res);

    expect(res._status).toBe(200);
    expect(profileService.setEmail).toHaveBeenCalled();
  });

  it('одноразовая почта не сохраняется и письма не получает', async () => {
    const { ctrl, profileService, email } = makeController({
      email: { isTempmail: jest.fn().mockReturnValue(true) },
    });
    const res = mockRes();

    await ctrl.setEmail({ userId: 'u-1' }, { email: 'x@tempmail.dev' }, res);

    expect(res._status).toBe(400);
    expect(profileService.setEmail).not.toHaveBeenCalled();
    expect(email.sendVerifyEmail).not.toHaveBeenCalled();
  });

  it('мусор вместо адреса отвергается', async () => {
    const { ctrl, profileService } = makeController();
    const res = mockRes();

    await ctrl.setEmail({ userId: 'u-1' }, { email: 'не-почта' }, res);

    expect(res._status).toBe(400);
    expect(profileService.setEmail).not.toHaveBeenCalled();
  });
});
