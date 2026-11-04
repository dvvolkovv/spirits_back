jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import { ConflictException } from '@nestjs/common';
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
    claimDraft: jest.fn(),
    finalizeDraft: jest.fn(),
    releaseDraft: jest.fn(),
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
  const logger = { warn: jest.fn() };
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
  const maybeInput = (overrides: Record<string, unknown> = {}) => ({
    chatId: CHAT,
    questionMessageId: 100,
    text: 'текст',
    identity,
    ticket: { id: TICKET, status: 'escalated' },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (drafts as any).logger = logger;
    store.createDraft.mockResolvedValue(DRAFT);
    store.getDraft.mockResolvedValue(draft());
    store.consumeDraft.mockResolvedValue(true);
    store.claimDraft.mockResolvedValue(true);
    store.finalizeDraft.mockResolvedValue(true);
    store.releaseDraft.mockResolvedValue(true);
    store.attachDraftPrompt.mockResolvedValue(undefined);
    support.adminGetTicket.mockResolvedValue({ ticket: { id: TICKET, status: 'owner_handling' } });
    support.postOwnerReplyFromTelegram.mockResolvedValue(undefined);
    telegram.sendMessage.mockResolvedValue({ message_id: 900 });
    telegram.editMessageText.mockResolvedValue(undefined);
    telegram.answerCallbackQuery.mockResolvedValue(undefined);
  });

  it('maybeDraft создаёт черновик и отправляет ровно три inline-кнопки', async () => {
    await drafts.maybeDraft(maybeInput());

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
    const result = await drafts.maybeDraft(maybeInput({ ticket: { id: TICKET, status } }));

    expect(result).toContain('закрыт');
    expect(store.createDraft).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('обрезает preview вместе с заголовком до лимита Telegram 4096', async () => {
    const text = 'я'.repeat(5000);

    await drafts.maybeDraft(maybeInput({ text }));

    const prompt = telegram.sendMessage.mock.calls[0][1];
    expect(prompt.length).toBeLessThanOrEqual(4096);
    expect(prompt).toContain(`#${TICKET.slice(0, 8)}`);
    expect(store.createDraft.mock.calls[0][0].text).toBe(text);
  });

  it('отменяет черновик, если prompt не удалось показать', async () => {
    telegram.sendMessage.mockRejectedValue(new Error('telegram down'));

    const result = await drafts.maybeDraft(maybeInput());

    expect(result).toContain('отмен');
    expect(store.finalizeDraft).toHaveBeenCalledWith(DRAFT, 'cancelled');
    expect(store.attachDraftPrompt).not.toHaveBeenCalled();
  });

  it('не падает и не дублирует видимый prompt при сбое attachDraftPrompt', async () => {
    store.attachDraftPrompt.mockRejectedValue(new Error('СЕКРЕТ-ИЗ-ОШИБКИ'));

    await expect(drafts.maybeDraft(maybeInput())).resolves.toBeNull();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.createDraft).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('alert-bot draft prompt attach failed');
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain('СЕКРЕТ');
  });

  it('чужой автор получает предупреждение, claimDraft не вызывается', async () => {
    const result = await drafts.handleCallback(callback({ tgUserId: '222', adminUserId: 'u-other' }));

    expect(result).toEqual({});
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Это черновик другого админа');
    expect(store.claimDraft).not.toHaveBeenCalled();
  });

  it('callback из другого чата не находит черновик и не производит side effects', async () => {
    const result = await drafts.handleCallback(callback({ chatId: '-100999' }));

    expect(result).toEqual({});
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Черновик не найден');
    expect(store.claimDraft).not.toHaveBeenCalled();
    expect(support.adminGetTicket).not.toHaveBeenCalled();
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
    expect(telegram.editMessageText).not.toHaveBeenCalled();
  });

  it('send делает claim, идемпотентно публикует и только затем финализирует sent', async () => {
    const result = await drafts.handleCallback(callback());

    expect(result).toEqual({});
    expect(store.claimDraft).toHaveBeenCalledWith(DRAFT, 'sending');
    expect(support.postOwnerReplyFromTelegram).toHaveBeenCalledWith(
      TICKET, '111', 'u-admin', 'текст', true, 'u-admin', DRAFT,
    );
    expect(store.finalizeDraft).toHaveBeenCalledWith(DRAFT, 'sent');
    expect(store.claimDraft.mock.invocationCallOrder[0]).toBeLessThan(support.adminGetTicket.mock.invocationCallOrder[0]);
    expect(support.adminGetTicket.mock.invocationCallOrder[0]).toBeLessThan(support.postOwnerReplyFromTelegram.mock.invocationCallOrder[0]);
    expect(support.postOwnerReplyFromTelegram.mock.invocationCallOrder[0]).toBeLessThan(store.finalizeDraft.mock.invocationCallOrder[0]);
    expect(telegram.editMessageText).toHaveBeenCalledWith(CHAT, 900, '✅ Отправлено');
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Отправлено');
  });

  it('повторный send после неудачного claim не дублирует ответ пользователю', async () => {
    store.claimDraft.mockResolvedValue(false);

    await drafts.handleCallback(callback());

    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Черновик устарел');
    expect(support.adminGetTicket).not.toHaveBeenCalled();
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
  });

  it('неожиданный сбой публикации освобождает черновик для безопасного retry', async () => {
    support.postOwnerReplyFromTelegram
      .mockRejectedValueOnce(new Error('uncertain post-commit failure'))
      .mockResolvedValueOnce(undefined);

    await drafts.handleCallback(callback({ callbackId: 'first' }));
    await drafts.handleCallback(callback({ callbackId: 'second' }));

    expect(store.claimDraft).toHaveBeenCalledTimes(2);
    expect(store.releaseDraft).toHaveBeenCalledWith(DRAFT);
    expect(store.releaseDraft).toHaveBeenCalledTimes(1);
    expect(store.finalizeDraft).toHaveBeenCalledWith(DRAFT, 'sent');
    expect(store.finalizeDraft).toHaveBeenCalledTimes(1);
    expect(support.postOwnerReplyFromTelegram).toHaveBeenCalledTimes(2);
    expect(support.postOwnerReplyFromTelegram.mock.calls[0][6]).toBe(DRAFT);
    expect(support.postOwnerReplyFromTelegram.mock.calls[1][6]).toBe(DRAFT);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(2);
    expect(telegram.answerCallbackQuery.mock.calls[1][1]).toBe('Отправлено');
  });

  it('сбой edit после успешной публикации не откатывает sent и подтверждает отправку', async () => {
    telegram.editMessageText.mockRejectedValue(new Error('message too old'));

    await expect(drafts.handleCallback(callback())).resolves.toEqual({});

    expect(store.finalizeDraft).toHaveBeenCalledWith(DRAFT, 'sent');
    expect(store.releaseDraft).not.toHaveBeenCalled();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Отправлено');
  });

  it.each(['send', 'ask', 'cancel'] as const)('%s возвращает результат, даже если answerCallbackQuery упал', async (action) => {
    telegram.answerCallbackQuery.mockRejectedValue(new Error('query is too old'));

    const result = await drafts.handleCallback(callback({ action }));

    if (action === 'ask') expect(result).toEqual({ question: 'текст', ticketId: TICKET });
    else expect(result).toEqual({});
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(store.finalizeDraft).toHaveBeenCalledWith(DRAFT, action === 'send' ? 'sent' : action === 'ask' ? 'asked' : 'cancelled');
  });

  it('cancel финализирует черновик и меняет prompt на «Отменено»', async () => {
    await drafts.handleCallback(callback({ action: 'cancel' }));

    expect(store.claimDraft).toHaveBeenCalledWith(DRAFT, 'cancelling');
    expect(store.finalizeDraft).toHaveBeenCalledWith(DRAFT, 'cancelled');
    expect(telegram.editMessageText).toHaveBeenCalledWith(CHAT, 900, 'Отменено');
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
  });

  it('ask возвращает вопрос и ticketId, сам модель не вызывает', async () => {
    const result = await drafts.handleCallback(callback({ action: 'ask' }));

    expect(result).toEqual({ question: 'текст', ticketId: TICKET });
    expect(store.claimDraft).toHaveBeenCalledWith(DRAFT, 'asking');
    expect(store.finalizeDraft).toHaveBeenCalledWith(DRAFT, 'asked');
    expect(support.adminGetTicket).not.toHaveBeenCalled();
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it('просроченный черновик нельзя отправить', async () => {
    store.getDraft.mockResolvedValue(draft({ expiresAt: new Date(Date.now() - 1000) }));
    store.claimDraft.mockResolvedValue(false);

    await drafts.handleCallback(callback());

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Черновик устарел');
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
  });

  it.each(['resolved', 'closed'])('перед send повторно читает тикет и отменяет черновик для статуса %s', async (status) => {
    support.adminGetTicket.mockResolvedValue({ ticket: { id: TICKET, status } });

    await drafts.handleCallback(callback());

    expect(support.adminGetTicket).toHaveBeenCalledWith(TICKET);
    expect(support.postOwnerReplyFromTelegram).not.toHaveBeenCalled();
    expect(store.finalizeDraft).toHaveBeenCalledWith(DRAFT, 'cancelled');
    expect(store.releaseDraft).not.toHaveBeenCalled();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery.mock.calls[0][1]).toContain('закрыт');
  });

  it('гонку закрытия под row lock отменяет, а не помечает sent', async () => {
    support.postOwnerReplyFromTelegram.mockRejectedValue(new ConflictException('ticket is terminal'));

    await drafts.handleCallback(callback());

    expect(store.finalizeDraft).toHaveBeenCalledWith(DRAFT, 'cancelled');
    expect(store.finalizeDraft).not.toHaveBeenCalledWith(DRAFT, 'sent');
    expect(store.releaseDraft).not.toHaveBeenCalled();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery.mock.calls[0][1]).toContain('закрыт');
  });

  it('при ошибке публикации callback получает ровно один безопасный ответ', async () => {
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
    expect(store.claimDraft).not.toHaveBeenCalled();
  });
});
