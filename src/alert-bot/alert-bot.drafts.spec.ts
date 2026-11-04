jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import { AlertBotDrafts } from './alert-bot.drafts';

const TICKET = '11111111-1111-4111-8111-111111111111';
const DRAFT = '22222222-2222-4222-8222-222222222222';
const CHAT = '-100123';
const identity = { tgUserId: '111', adminUserId: 'u-admin' };

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT,
    chatId: CHAT,
    tgUserId: '111',
    adminUserId: 'u-admin',
    ticketId: TICKET,
    text: 'текст',
    promptMessageId: 900,
    expiresAt: new Date(Date.now() + 60_000),
    outcome: null,
    createdAt: new Date(),
    resolvedAt: null,
    ...overrides,
  };
}

describe('черновики ответов в тикет', () => {
  const store = {
    createDraft: jest.fn(),
    getDraft: jest.fn(),
    consumeDraft: jest.fn(),
    attachDraftPrompt: jest.fn(),
  };
  const support = {
    adminGetTicket: jest.fn(),
    postOwnerReplyFromTelegram: jest.fn(),
  };
  const telegram = {
    sendMessage: jest.fn(),
    editMessageText: jest.fn(),
    answerCallbackQuery: jest.fn(),
  };
  const drafts = new AlertBotDrafts(store as any, support as any, telegram as any);
  const callback = (overrides: Record<string, unknown> = {}) => ({
    callbackId: 'callback-1',
    chatId: CHAT,
    ...identity,
    draftId: DRAFT,
    action: 'send' as const,
    messageId: 900,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    store.createDraft.mockResolvedValue(DRAFT);
    store.getDraft.mockResolvedValue(draft());
    store.consumeDraft.mockResolvedValue(true);
    store.attachDraftPrompt.mockResolvedValue(undefined);
    support.adminGetTicket.mockResolvedValue({ ticket: { id: TICKET, status: 'owner_handling' } });
    support.postOwnerReplyFromTelegram.mockResolvedValue(undefined);
    telegram.sendMessage.mockResolvedValue({ message_id: 900 });
    telegram.editMessageText.mockResolvedValue(undefined);
    telegram.answerCallbackQuery.mockResolvedValue(undefined);
  });

  it('maybeDraft создаёт черновик и отправляет ровно три inline-кнопки', async () => {
    await drafts.maybeDraft({
      chatId: CHAT,
      questionMessageId: 100,
      text: 'текст',
      identity,
      ticket: { id: TICKET, status: 'escalated' },
    });

    expect(store.createDraft).toHaveBeenCalledWith({
      chatId: CHAT,
      tgUserId: '111',
      adminUserId: 'u-admin',
      ticketId: TICKET,
      text: 'текст',
    });
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, , replyTo, markup] = telegram.sendMessage.mock.calls[0];
    expect(chatId).toBe(CHAT);
    expect(replyTo).toBe(100);
    const buttons = markup.inline_keyboard.flat();
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button: any) => button.callback_data)).toEqual([
      `draft:${DRAFT}:send`,
      `draft:${DRAFT}:ask`,
      `draft:${DRAFT}:cancel`,
    ]);
    expect(store.attachDraftPrompt).toHaveBeenCalledWith(DRAFT, 900);
  });

  it.each(['resolved', 'closed'])('терминальный тикет %s возвращает предупреждение без черновика', async (status) => {
    const result = await drafts.maybeDraft({
      chatId: CHAT,
      questionMessageId: 100,
      text: 'текст',
      identity,
      ticket: { id: TICKET, status },
    });

    expect(result).toContain('закрыт');
    expect(store.createDraft).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('чужой автор получает предупреждение, consumeDraft не вызывается', async () => {
    const result = await drafts.handleCallback(callback({ tgUserId: '222', adminUserId: 'u-other' }));

    expect(result).toEqual({});
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Это черновик другого админа');
    expect(store.consumeDraft).not.toHaveBeenCalled();
  });

  it('send публикует ответ от аккаунта админа, отвечает на callback и меняет prompt', async () => {
    const result = await drafts.handleCallback(callback());

    expect(result).toEqual({});
    expect(store.consumeDraft).toHaveBeenCalledWith(DRAFT, 'sent');
    expect(support.postOwnerReplyFromTelegram).toHaveBeenCalledWith(
      TICKET, '111', 'u-admin', 'текст', true, 'u-admin',
    );
    expect(store.consumeDraft.mock.invocationCallOrder[0]).toBeLessThan(support.adminGetTicket.mock.invocationCallOrder[0]);
    expect(support.adminGetTicket.mock.invocationCallOrder[0]).toBeLessThan(support.postOwnerReplyFromTelegram.mock.invocationCallOrder[0]);
    expect(telegram.editMessageText).toHaveBeenCalledWith(CHAT, 900, '✅ Отправлено');
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Отправлено');
  });

  it('повторный send после consumeDraft=false не дублирует ответ пользователю', async () => {
    store.consumeDraft.mockResolvedValue(false);

    await drafts.handleCallback(callback());

    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Черновик устарел');
    expect(support.adminGetTicket).not.toHaveBeenCalled();
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
  });

  it('cancel помечает черновик и меняет prompt на «Отменено»', async () => {
    await drafts.handleCallback(callback({ action: 'cancel' }));

    expect(store.consumeDraft).toHaveBeenCalledWith(DRAFT, 'cancelled');
    expect(telegram.editMessageText).toHaveBeenCalledWith(CHAT, 900, 'Отменено');
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
  });

  it('ask возвращает вопрос и ticketId, сам модель не вызывает', async () => {
    const result = await drafts.handleCallback(callback({ action: 'ask' }));

    expect(result).toEqual({ question: 'текст', ticketId: TICKET });
    expect(store.consumeDraft).toHaveBeenCalledWith(DRAFT, 'asked');
    expect(support.adminGetTicket).not.toHaveBeenCalled();
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it('просроченный черновик нельзя отправить', async () => {
    store.getDraft.mockResolvedValue(draft({ expiresAt: new Date(Date.now() - 1000) }));
    store.consumeDraft.mockResolvedValue(false);

    await drafts.handleCallback(callback());

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Черновик устарел');
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
  });

  it.each(['resolved', 'closed'])('перед send повторно читает тикет и отказывает для статуса %s', async (status) => {
    support.adminGetTicket.mockResolvedValue({ ticket: { id: TICKET, status } });

    await drafts.handleCallback(callback());

    expect(support.adminGetTicket).toHaveBeenCalledWith(TICKET);
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery.mock.calls[0][1]).toContain('закрыт');
  });

  it('при ошибке публикации callback всё равно получает ровно один ответ', async () => {
    support.postOwnerReplyFromTelegram.mockRejectedValue(new Error('секрет из ошибки'));

    await expect(drafts.handleCallback(callback())).resolves.toEqual({});

    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery.mock.calls[0][1]).not.toContain('секрет');
    expect(telegram.editMessageText).not.toHaveBeenCalled();
  });

  it('при ошибке чтения черновика callback всё равно получает ровно один ответ', async () => {
    store.getDraft.mockRejectedValue(new Error('database down'));

    await expect(drafts.handleCallback(callback())).resolves.toEqual({});

    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(store.consumeDraft).not.toHaveBeenCalled();
  });
});
