import { TgProductActionsService, shouldRouteToProductActions } from './tg-product-actions.service';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function harness(o: { owner?: number; action?: any } = {}) {
  const actions = {
    takeForTurn: jest.fn(async () => [{ id: ID, kind: 'delete', payload: { name: 'Магазин' } }]),
    setTelegramMessage: jest.fn(async () => undefined),
    getById: jest.fn(async () => o.action ?? { id: ID, user_id: 'u1', kind: 'delete', status: 'pending', payload: { name: 'Магазин' }, product_name: 'Магазин' }),
    cancel: jest.fn(async () => true),
  };
  const lifecycle = { completeDelete: jest.fn(async () => ({ ok: true, restoreUntil: '2026-11-24T10:00:00.000Z' })) };
  const grammy = {
    sendMessage: jest.fn(async () => ({ message_id: 77 })),
    editMessageText: jest.fn(async () => undefined),
    answerCallbackQuery: jest.fn(async () => undefined),
  };
  const identity = { getIdentityByLinkeonId: jest.fn(async () => ({ tgUserId: o.owner ?? 42, tgUsername: null, tgFirstName: null })) };
  const svc = new TgProductActionsService(actions as any, lifecycle as any, grammy as any, identity as any);
  return { svc, actions, lifecycle, grammy, identity };
}

describe('карточки продуктов в Telegram', () => {
  it('префикс pa: — наш', () => {
    expect(shouldRouteToProductActions(`pa:ok:${ID}`)).toBe(true);
    expect(shouldRouteToProductActions('ins:b:1')).toBe(false);
  });

  it('удаление — сообщение с кнопками «Удалить» и «Отмена»', async () => {
    const h = harness();
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang: 'ru' });
    const [chatId, text, opts] = h.grammy.sendMessage.mock.calls[0] as any[];
    expect(chatId).toBe(100);
    expect(text).toMatch(/Удалить «Магазин»\?/);
    expect(opts.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual([`pa:ok:${ID}`, `pa:no:${ID}`]);
    expect(h.actions.setTelegramMessage).toHaveBeenCalledWith(ID, 100, 77);
  });

  it('бот в личке — кнопка мини-приложения; в группе — ссылка на кабинет', async () => {
    const h = harness();
    h.actions.takeForTurn.mockResolvedValue([{ id: ID, kind: 'create_bot', payload: { name: 'Бот' } }] as any);
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang: 'ru' });
    expect((h.grammy.sendMessage.mock.calls[0] as any[])[2].reply_markup.inline_keyboard[0][0].web_app.url).toMatch(new RegExp(`/tma/#pa=${ID}$`));
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: -100, isPrivate: false, lang: 'ru' });
    expect((h.grammy.sendMessage.mock.calls[1] as any[])[2].reply_markup.inline_keyboard[0][0].url).toMatch(new RegExp(`/studio\\?tab=products&action=${ID}$`));
  });

  it('нажать «Удалить» может только привязанный Telegram владельца', async () => {
    const h = harness({ owner: 42 });
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 999 }, message: { chat: { id: 100 }, message_id: 77 } });
    expect(h.lifecycle.completeDelete).not.toHaveBeenCalled();
  });

  it('«Удалить» владельцем — удаление и правка сообщения без кнопок', async () => {
    const h = harness({ owner: 42 });
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42, language_code: 'ru' }, message: { chat: { id: 100 }, message_id: 77 } });
    expect(h.lifecycle.completeDelete).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, via: 'telegram' });
    const [, , text, opts] = h.grammy.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/удалён/);
    expect(opts.reply_markup.inline_keyboard).toEqual([]);
  });

  it('«Отмена» — отмена действия', async () => {
    const h = harness({ owner: 42 });
    await h.svc.handleCallback({ id: 'cb', data: `pa:no:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
    expect(h.actions.cancel).toHaveBeenCalledWith('u1', ID);
  });
});
