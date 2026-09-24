import { NotFoundException } from '@nestjs/common';
import { ProductsController } from './products.controller';

describe('ручки своего домена', () => {
  const make = () => {
    const domains = {
      get: jest.fn(async () => null),
      attach: jest.fn(async () => ({ domain: 'a.ru' })),
      check: jest.fn(async () => ({ domain: 'a.ru' })),
      detach: jest.fn(async () => ({ removed: 'now' })),
    };
    const ctrl = new ProductsController({} as any, {} as any, {} as any, {} as any, {} as any, domains as any);
    return { ctrl, domains };
  };
  const user = { userId: '79030169187' };
  const ID = '11111111-2222-3333-4444-555555555555';

  it('владелец берётся из токена, а не из тела', async () => {
    const { ctrl, domains } = make();
    await ctrl.attachDomain(user, ID, { domain: 'a.ru', userId: '70000000000' } as any);
    expect(domains.attach).toHaveBeenCalledWith('79030169187', ID, 'a.ru');
  });

  it('кривой идентификатор отбивается до сервиса', async () => {
    const { ctrl, domains } = make();
    await expect(ctrl.getDomain(user, 'не-uuid')).rejects.toBeInstanceOf(NotFoundException);
    expect(domains.get).not.toHaveBeenCalled();
  });

  it('ответы в конверте { domain }', async () => {
    const { ctrl } = make();
    await expect(ctrl.getDomain(user, ID)).resolves.toEqual({ domain: null });
    await expect(ctrl.checkDomain(user, ID)).resolves.toEqual({ domain: { domain: 'a.ru' } });
    await expect(ctrl.detachDomain(user, ID)).resolves.toEqual({ removed: 'now' });
  });
});
