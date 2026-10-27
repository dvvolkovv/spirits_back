import { EventsService } from './events.service';

/// Крючки «источник входа записан».
///
/// Веб шлёт источник привлечения (`/webhook/events/attribute`) запросом с
/// keepalive — он доходит, даже если сразу после входа страница уходит дальше.
/// Отдельный запрос на привязку к реферальной ссылке такой гарантии не имеет и
/// иногда обрывается: человек пришёл по ссылке, источник `referral:<slug>`
/// записан, а привязки нет. Крючок даёт реферальному модулю второй шанс на
/// том запросе, который доходит.

function fakePg() {
  return { query: jest.fn(async () => ({ rows: [], rowCount: 1 })) };
}

describe('EventsService — крючки источника входа', () => {
  it('крючок получает пользователя и источник', async () => {
    const svc = new EventsService(fakePg() as any);
    const hook = jest.fn(async () => undefined);
    svc.onAttribution(hook);

    await svc.setSignupSourceIfEmpty('u-1', 'referral:abc12345', '');

    expect(hook).toHaveBeenCalledWith('u-1', 'referral:abc12345');
  });

  it('упавший крючок не роняет запрос и не мешает следующему', async () => {
    const svc = new EventsService(fakePg() as any);
    const second = jest.fn(async () => undefined);
    svc.onAttribution(async () => { throw new Error('boom'); });
    svc.onAttribution(second);

    await expect(svc.setSignupSourceIfEmpty('u-1', 'referral:abc12345')).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledWith('u-1', 'referral:abc12345');
  });

  it('источник не из допустимых — крючки не зовутся', async () => {
    const svc = new EventsService(fakePg() as any);
    const hook = jest.fn(async () => undefined);
    svc.onAttribution(hook);

    await svc.setSignupSourceIfEmpty('u-1', 'javascript:alert(1)');

    expect(hook).not.toHaveBeenCalled();
  });
});
