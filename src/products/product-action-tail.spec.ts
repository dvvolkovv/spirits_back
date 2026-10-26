import { productActionTail } from './product-action-tail';

const A = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

describe('хвост ответа с карточками', () => {
  it('клиент с карточками — блок product-action с одним id', () => {
    expect(productActionTail([A], true, 'ru')).toBe('\n\n```product-action\n{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}\n```');
  });

  it('клиент без карточек — ссылка на кабинет на языке собеседника', () => {
    const t = productActionTail([A], false, 'de');
    expect(t).toBe('\n\nBestätige es in deinem Konto: https://my.linkeon.io/studio?tab=products&action=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('нет карточек — пусто', () => {
    expect(productActionTail([], true, 'ru')).toBe('');
  });
});
