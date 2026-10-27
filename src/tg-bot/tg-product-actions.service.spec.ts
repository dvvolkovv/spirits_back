import { TgProductActionsService, shouldRouteToProductActions } from './tg-product-actions.service';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function harness(o: { owner?: number; action?: any; profileLang?: string | null } = {}) {
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
  const identity = { getIdentityByLinkeonId: jest.fn(async () => (o.owner === null ? null : { tgUserId: o.owner ?? 42, tgUsername: null, tgFirstName: null })) };
  // Профиль владельца действия: только язык — остальное для карточек не нужно.
  const pg = { query: jest.fn(async () => ({ rows: [{ language: o.profileLang ?? null }] })) };
  const svc = new TgProductActionsService(actions as any, lifecycle as any, grammy as any, identity as any, pg as any);
  return { svc, actions, lifecycle, grammy, identity, pg };
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

  it('takeForTurn — с меткой хода, окном и каналом telegram', async () => {
    const h = harness();
    const since = new Date('2026-10-26T10:00:00.000Z');
    await h.svc.sendForTurn({ userId: 'u1', turn: 'turn-1', since, chatId: 100, isPrivate: true, lang: 'ru' });
    expect(h.actions.takeForTurn).toHaveBeenCalledWith('u1', 'turn-1', since, 'telegram');
  });

  it('бот в личке — кнопка мини-приложения; в группе — ссылка на кабинет', async () => {
    const h = harness();
    h.actions.takeForTurn.mockResolvedValue([{ id: ID, kind: 'create_bot', payload: { name: 'Бот' } }] as any);
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang: 'ru' });
    expect((h.grammy.sendMessage.mock.calls[0] as any[])[2].reply_markup.inline_keyboard[0][0].web_app.url).toMatch(new RegExp(`/tma/\\?pa=${ID}$`));
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: -100, isPrivate: false, lang: 'ru' });
    expect((h.grammy.sendMessage.mock.calls[1] as any[])[2].reply_markup.inline_keyboard[0][0].url).toMatch(new RegExp(`/studio\\?tab=products&action=${ID}$`));
  });

  it('ключи: в личке — кнопка мини-приложения, в группе — ссылка на кабинет; ключи в переписку не просим', async () => {
    const h = harness();
    h.actions.takeForTurn.mockResolvedValue([{ id: ID, kind: 'keys', payload: { name: 'Магазин' } }] as any);
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang: 'ru' });
    const [, text, opts] = h.grammy.sendMessage.mock.calls[0] as any[];
    expect(text).toMatch(/Ключи «Магазин»/);
    expect(text).toMatch(/В переписку ключи не присылайте/);
    expect(opts.reply_markup.inline_keyboard[0][0].web_app.url).toMatch(new RegExp(`/tma/\\?pa=${ID}$`));
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: -100, isPrivate: false, lang: 'ru' });
    expect((h.grammy.sendMessage.mock.calls[1] as any[])[2].reply_markup.inline_keyboard[0][0].url)
      .toMatch(new RegExp(`/studio\\?tab=products&action=${ID}$`));
  });

  it('карточка неизвестного вида — пропускается, сообщение не шлётся', async () => {
    const h = harness();
    h.actions.takeForTurn.mockResolvedValue([{ id: ID, kind: 'zzz', payload: { name: 'Магазин' } }] as any);
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang: 'ru' });
    expect(h.grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('текст ключей есть на всех семи языках и называет продукт', async () => {
    for (const lang of ['ru', 'en', 'de', 'fr', 'es', 'pt', 'zh']) {
      const h = harness();
      h.actions.takeForTurn.mockResolvedValue([{ id: ID, kind: 'keys', payload: { name: 'Shop' } }] as any);
      await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang });
      const [, text, opts] = h.grammy.sendMessage.mock.calls[0] as any[];
      expect(text).toContain('Shop');
      expect(text).not.toMatch(/\{name\}/);
      expect(opts.reply_markup.inline_keyboard[0][0].text.length).toBeGreaterThan(0);
    }
  });

  it('первая карточка не отправилась — вторая всё равно уходит', async () => {
    const h = harness();
    h.actions.takeForTurn.mockResolvedValue([
      { id: ID, kind: 'delete', payload: { name: 'Первый' } },
      { id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'delete', payload: { name: 'Второй' } },
    ] as any);
    h.grammy.sendMessage.mockRejectedValueOnce(new Error('bot was blocked by the user'));
    h.grammy.sendMessage.mockResolvedValueOnce({ message_id: 78 } as any);
    await h.svc.sendForTurn({ userId: 'u1', turn: 't', since: new Date(), chatId: 100, isPrivate: true, lang: 'ru' });
    expect(h.grammy.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.actions.setTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it('нажать «Удалить» может только привязанный Telegram владельца', async () => {
    const h = harness({ owner: 42 });
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 999 }, message: { chat: { id: 100 }, message_id: 77 } });
    expect(h.lifecycle.completeDelete).not.toHaveBeenCalled();
  });

  it('владелец без привязанного Telegram (identity вернула null) — ничего не происходит', async () => {
    const h = harness({ owner: null as any });
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
    expect(h.lifecycle.completeDelete).not.toHaveBeenCalled();
    expect(h.grammy.editMessageText).not.toHaveBeenCalled();
  });

  it('нажатие не владельца не отменяет действие (pa:no)', async () => {
    const h = harness({ owner: 42 });
    await h.svc.handleCallback({ id: 'cb', data: `pa:no:${ID}`, from: { id: 999 }, message: { chat: { id: 100 }, message_id: 77 } });
    expect(h.actions.cancel).not.toHaveBeenCalled();
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

  // Профиль владельца выигрывает у языка клиента (решение владельца —
  // профиль кабинета/мини-аппа, ownerTgLanguage): нажавший может писать с
  // другого устройства/языка интерфейса, но результат должен звучать как
  // остальной бот — на языке профиля.
  it('язык результата — язык профиля владельца действия, не клиента Telegram', async () => {
    const h = harness({ owner: 42, profileLang: 'de' });
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42, language_code: 'en' }, message: { chat: { id: 100 }, message_id: 77 } });
    const [, , text] = h.grammy.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/gelöscht/);
  });

  it('язык результата — без профиля и с незнакомым клиенту языком клиента Telegram — английский', async () => {
    const h = harness({ owner: 42, profileLang: null });
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42, language_code: 'it' }, message: { chat: { id: 100 }, message_id: 77 } });
    const [, , text] = h.grammy.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/has been deleted/);
  });

  // Карточка удалена, но архивация продукта провалилась («gone» — продукт уже
  // удалён или ещё заводится): отдельный текст, не общий «не получилось».
  it('completeDelete reason=gone — отдельный текст, без сырого r.message', async () => {
    const h = harness({ owner: 42, profileLang: 'ru' });
    h.lifecycle.completeDelete.mockResolvedValueOnce({ ok: false, reason: 'gone', message: 'Продукт уже удалён или ещё заводится' } as any);
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
    const [, , text] = h.grammy.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/уже удалён или ещё заводится/);
  });

  it('completeDelete отказал по прочей причине — общий текст без {reason}', async () => {
    const h = harness({ owner: 42, profileLang: 'ru' });
    h.lifecycle.completeDelete.mockResolvedValueOnce({ ok: false, reason: 'failed', message: 'упало на архивации — детали в стектрейсе' } as any);
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
    const [, , text] = h.grammy.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/Не получилось — попробуйте ещё раз позже/);
    expect(text).not.toMatch(/стектрейс/);
  });

  // Ревью, круг 2, пункт 7: reason='blocked' — свой текст (pa_blocked), а не
  // общий pa_failed («попробуйте ещё раз позже» неправда для блокировки).
  it('completeDelete reason=blocked — отдельный текст про поддержку, не общий pa_failed', async () => {
    const h = harness({ owner: 42, profileLang: 'ru' });
    h.lifecycle.completeDelete.mockResolvedValueOnce({
      ok: false, reason: 'blocked',
      message: 'Продукт остановлен администратором — удалить его можно через поддержку',
    } as any);
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
    const [, , text] = h.grammy.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/остановлен администратором/);
    expect(text).not.toMatch(/попробуйте ещё раз позже/);
  });

  // not_pending — повторное нажатие или нажатие после того, как действие уже
  // закрылось где-то ещё: текст должен звучать по тому, чем действие стало на
  // самом деле, а не единым «подтверждение закрыто».
  it('повторное нажатие «Удалить» после уже проведённого удаления — текст об удалении с датой', async () => {
    const h = harness({ owner: 42, profileLang: 'ru' });
    h.lifecycle.completeDelete.mockResolvedValueOnce({ ok: false, reason: 'not_pending', message: 'Карточка уже закрыта или срок вышел' } as any);
    h.actions.getById.mockResolvedValue({
      id: ID, user_id: 'u1', kind: 'delete', status: 'done', payload: { name: 'Магазин' }, product_name: 'Магазин',
      result: { restoreUntil: '2026-11-24T10:00:00.000Z' },
    } as any);
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
    const [, , text] = h.grammy.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/удалён/);
    expect(text).toMatch(/24 ноября/);
  });

  it('нажатие «Удалить» после отмены действия — текст об отмене', async () => {
    const h = harness({ owner: 42, profileLang: 'ru' });
    h.lifecycle.completeDelete.mockResolvedValueOnce({ ok: false, reason: 'not_pending', message: 'Карточка уже закрыта или срок вышел' } as any);
    h.actions.getById.mockResolvedValue({ id: ID, user_id: 'u1', kind: 'delete', status: 'cancelled', payload: { name: 'Магазин' }, product_name: 'Магазин' } as any);
    await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
    const [, , text] = h.grammy.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/Удаление отменено/);
  });

  it('повторное нажатие «Отмена» (cancel вернул false) — текст по фактическому статусу', async () => {
    const h = harness({ owner: 42, profileLang: 'ru' });
    h.actions.cancel.mockResolvedValueOnce(false);
    h.actions.getById.mockResolvedValue({ id: ID, user_id: 'u1', kind: 'delete', status: 'cancelled', payload: { name: 'Магазин' }, product_name: 'Магазин' } as any);
    await h.svc.handleCallback({ id: 'cb', data: `pa:no:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
    const [, , text] = h.grammy.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/Удаление отменено/);
  });

  // answerCallbackQuery гасит спиннер кнопки у нажавшего и должен уйти ровно
  // один раз на любой исход: правильное нажатие, чужое, malformed data.
  describe('answerCallbackQuery — ровно один раз на каждый путь', () => {
    it('нажатие владельцем (ok)', async () => {
      const h = harness({ owner: 42 });
      await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
      expect(h.grammy.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('«Отмена» (no)', async () => {
      const h = harness({ owner: 42 });
      await h.svc.handleCallback({ id: 'cb', data: `pa:no:${ID}`, from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
      expect(h.grammy.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('malformed data', async () => {
      const h = harness({ owner: 42 });
      await h.svc.handleCallback({ id: 'cb', data: 'pa:bad', from: { id: 42 }, message: { chat: { id: 100 }, message_id: 77 } });
      expect(h.grammy.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('нажатие не владельца', async () => {
      const h = harness({ owner: 42 });
      await h.svc.handleCallback({ id: 'cb', data: `pa:ok:${ID}`, from: { id: 999 }, message: { chat: { id: 100 }, message_id: 77 } });
      expect(h.grammy.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });
  });
});
