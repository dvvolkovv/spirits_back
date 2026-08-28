import { BusinessProfileController } from './business-profile.controller';

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  return r;
}

describe('BusinessProfileController', () => {
  it('GET отдаёт карточку и флаг видимости', async () => {
    const svc = {
      read: jest.fn(async () => ({ what: { value: 'студия', source: 'user', updated_at: 'x' } })),
      hasBusinessHistory: jest.fn(async () => false),
    } as any;
    const r = res();

    await new BusinessProfileController(svc).get({ user: { userId: 'u1' } } as any, r);

    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith({
      profile: { what: { value: 'студия', source: 'user', updated_at: 'x' } },
      visible: true,
    });
  });

  it('GET: пустая карточка + история с бизнес-ассистентом = блок показываем', async () => {
    const svc = {
      read: jest.fn(async () => ({})),
      hasBusinessHistory: jest.fn(async () => true),
    } as any;
    const r = res();

    await new BusinessProfileController(svc).get({ user: { userId: 'u1' } } as any, r);

    expect(r.json).toHaveBeenCalledWith({ profile: {}, visible: true });
  });

  it('GET: пусто и истории нет — блок скрываем', async () => {
    const svc = {
      read: jest.fn(async () => ({})),
      hasBusinessHistory: jest.fn(async () => false),
    } as any;
    const r = res();

    await new BusinessProfileController(svc).get({ user: { userId: 'u1' } } as any, r);

    expect(r.json).toHaveBeenCalledWith({ profile: {}, visible: false });
  });

  it('POST пишет с source=user', async () => {
    const svc = { merge: jest.fn(async () => ({ ok: true })) } as any;
    const r = res();

    await new BusinessProfileController(svc).update(
      { user: { userId: 'u1' } } as any, { fields: { tax_mode: 'usn_d' } }, r,
    );

    expect(svc.merge).toHaveBeenCalledWith('u1', { tax_mode: 'usn_d' }, 'user');
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('без userId отдаёт 401', async () => {
    const svc = { read: jest.fn(), hasBusinessHistory: jest.fn() } as any;
    const r = res();

    await new BusinessProfileController(svc).get({ user: {} } as any, r);

    expect(r.status).toHaveBeenCalledWith(401);
    expect(svc.read).not.toHaveBeenCalled();
  });
});
