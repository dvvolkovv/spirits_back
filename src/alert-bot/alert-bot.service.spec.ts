jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import { AlertBotService } from './alert-bot.service';

const TICKET = '11111111-1111-4111-8111-111111111111';
const DRAFT = '22222222-2222-4222-8222-222222222222';
const ADMIN = { userId: 'admin-1', isAdmin: true };

function update(message: Record<string, unknown> = {}, updateId = 1): any {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      text: 'Что происходит?',
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      ...message,
    },
  };
}

function groupText(text: string | undefined, updateId = 1, message: Record<string, unknown> = {}): any {
  return update({
    text,
    chat: { id: -100123, type: 'supergroup' },
    ...message,
  }, updateId);
}

function botReply(text: string, messageId = 555): any {
  return {
    message_id: messageId,
    text,
    chat: { id: 100, type: 'private' },
    from: { id: 999, is_bot: true, username: 'linkeon_alert_bot' },
  };
}

function callback(data: string, overrides: Record<string, unknown> = {}, updateId = 1): any {
  return {
    update_id: updateId,
    callback_query: {
      id: 'callback-1',
      data,
      from: { id: 200 },
      message: {
        message_id: 900,
        chat: { id: 100, type: 'private' },
      },
      ...overrides,
    },
  };
}

describe('AlertBotService', () => {
  const savedChatIds = process.env.TELEGRAM_CHAT_ID;
  let access: { resolveTelegram: jest.Mock };
  let telegram: Record<string, jest.Mock>;
  let store: Record<string, jest.Mock>;
  let commands: Record<string, jest.Mock>;
  let drafts: Record<string, jest.Mock>;
  let turns: { enqueue: jest.Mock };
  let support: { findTicketByPrefix: jest.Mock };
  let logger: { error: jest.Mock };
  let service: AlertBotService;

  beforeEach(() => {
    process.env.TELEGRAM_CHAT_ID = '-100123';
    access = { resolveTelegram: jest.fn().mockResolvedValue(ADMIN) };
    telegram = {
      getMe: jest.fn().mockResolvedValue({ id: 999, username: 'linkeon_alert_bot' }),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1000 }),
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
    };
    store = {
      claimUpdate: jest.fn().mockResolvedValue(true),
      findTurnByAnswer: jest.fn().mockResolvedValue(null),
    };
    commands = {
      start: jest.fn().mockResolvedValue('Справка'),
      status: jest.fn().mockResolvedValue('Сводка'),
      close: jest.fn().mockResolvedValue('✅ Тикет закрыт'),
    };
    drafts = {
      maybeDraft: jest.fn().mockResolvedValue(null),
      handleCallback: jest.fn().mockResolvedValue({}),
    };
    turns = { enqueue: jest.fn().mockResolvedValue(undefined) };
    support = { findTicketByPrefix: jest.fn().mockResolvedValue(null) };
    logger = { error: jest.fn() };
    service = new AlertBotService(
      access as any,
      telegram as any,
      store as any,
      commands as any,
      drafts as any,
      turns as any,
      support as any,
    );
    (service as any).logger = logger;
  });

  afterEach(() => {
    if (savedChatIds === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = savedChatIds;
    jest.restoreAllMocks();
  });

  it('private admin plain text передаёт вопрос в turns.enqueue', async () => {
    await service.handleUpdate(update({ text: 'Почему горит алерт?' }));

    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      updateId: 1,
      chatId: '100',
      tgUserId: '200',
      adminUserId: 'admin-1',
      questionMessageId: 10,
      question: 'Почему горит алерт?',
      privateChat: true,
    }));
    expect(drafts.maybeDraft).not.toHaveBeenCalled();
  });

  it('getMe кешируется между обновлениями', async () => {
    await service.handleUpdate(update({ text: 'Первый' }, 1));
    await service.handleUpdate(update({ text: 'Второй' }, 2));

    expect(telegram.getMe).toHaveBeenCalledTimes(1);
    expect(turns.enqueue).toHaveBeenCalledTimes(2);
  });

  it('non-admin private получает отказ не чаще одного раза в час, без turn', async () => {
    access.resolveTelegram.mockResolvedValue({ userId: 'user-1', isAdmin: false });

    await service.handleUpdate(update({}, 1));
    await service.handleUpdate(update({ text: 'Второй вопрос' }, 2));

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage.mock.calls[0][1]).toContain('только для администраторов');
    expect(turns.enqueue).not.toHaveBeenCalled();
    expect(store.createTurn).toBeUndefined();
  });

  it('unlisted group молчит даже для admin, а ordinary group message не вызывает resolveTelegram', async () => {
    await service.handleUpdate(update({ chat: { id: -100999, type: 'group' } }, 1));
    await service.handleUpdate(groupText('Обычный разговор', 2));

    expect(access.resolveTelegram).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('/ask@linkeon_alert_bot работает, а /ask@other игнорируется', async () => {
    await service.handleUpdate(groupText('/ask@linkeon_alert_bot Почему алерт?', 1));
    await service.handleUpdate(groupText('/ask@other Не наш вопрос', 2));

    expect(turns.enqueue).toHaveBeenCalledTimes(1);
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({ question: 'Почему алерт?' }));
    expect(access.resolveTelegram).toHaveBeenCalledTimes(1);
  });

  it('group reply боту и @mention адресуют вопрос без лишней групповой истории', async () => {
    store.findTurnByAnswer.mockResolvedValue({ id: 'parent-group' });
    await service.handleUpdate(groupText('Продолжи', 1, {
      reply_to_message: { ...botReply('Первый ответ'), chat: { id: -100123, type: 'supergroup' } },
    }));
    await service.handleUpdate(groupText('@linkeon_alert_bot Что с алертом?', 2));

    expect(turns.enqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      question: 'Продолжи', parentTurnId: 'parent-group', privateChat: false,
    }));
    expect(turns.enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({
      question: 'Что с алертом?', privateChat: false,
    }));
    expect(access.resolveTelegram).toHaveBeenCalledTimes(2);
  });

  it('reply на ответ бота всегда follow-up с parentTurnId, без drafts и ticket lookup', async () => {
    store.findTurnByAnswer.mockResolvedValue({ id: 'parent-1' });

    await service.handleUpdate(update({
      text: 'А подробнее?',
      reply_to_message: botReply('Причина в тикете #11111111'),
    }));

    expect(store.findTurnByAnswer).toHaveBeenCalledWith('100', 555);
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      question: 'А подробнее?', parentTurnId: 'parent-1', replyText: 'Причина в тикете #11111111',
    }));
    expect(drafts.maybeDraft).not.toHaveBeenCalled();
    expect(support.findTicketByPrefix).not.toHaveBeenCalled();
  });

  it('reply ко второму chunk ответа сохраняет parentTurnId и не создаёт draft', async () => {
    store.findTurnByAnswer.mockResolvedValue({ id: 'parent-chunks' });

    await service.handleUpdate(update({
      text: 'Поясни продолжение',
      reply_to_message: botReply('Вторая часть с #11111111', 902),
    }));

    expect(store.findTurnByAnswer).toHaveBeenCalledWith('100', 902);
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({ parentTurnId: 'parent-chunks' }));
    expect(drafts.maybeDraft).not.toHaveBeenCalled();
    expect(support.findTicketByPrefix).not.toHaveBeenCalled();
  });

  it('reply на escalation #11111111 без /ask создаёт draft', async () => {
    support.findTicketByPrefix.mockResolvedValue({ id: TICKET, status: 'escalated' });

    await service.handleUpdate(update({
      text: 'Ответ пользователю',
      reply_to_message: botReply('Эскалация #11111111'),
    }));

    expect(support.findTicketByPrefix).toHaveBeenCalledWith('11111111');
    expect(drafts.maybeDraft).toHaveBeenCalledWith(expect.objectContaining({
      chatId: '100', questionMessageId: 10, text: 'Ответ пользователю',
      identity: { tgUserId: '200', adminUserId: 'admin-1' },
      ticket: { id: TICKET, status: 'escalated' },
    }));
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('reply на escalation с /ask передаёт вопрос с resolved ticketId', async () => {
    support.findTicketByPrefix.mockResolvedValue({ id: TICKET, status: 'escalated' });

    await service.handleUpdate(update({
      text: '/ask Разбери причину',
      reply_to_message: botReply('Эскалация #11111111'),
    }));

    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Разбери причину', ticketId: TICKET, replyText: 'Эскалация #11111111',
    }));
    expect(drafts.maybeDraft).not.toHaveBeenCalled();
  });

  it('reply без найденного тикета остаётся вопросом с replyText', async () => {
    support.findTicketByPrefix.mockResolvedValue(null);

    await service.handleUpdate(update({
      text: 'Что это значит?',
      reply_to_message: botReply('Эскалация #11111111'),
    }));

    expect(support.findTicketByPrefix).toHaveBeenCalledWith('11111111');
    expect(drafts.maybeDraft).not.toHaveBeenCalled();
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Что это значит?', replyText: 'Эскалация #11111111',
    }));
  });

  it('полный UUID в reply разрешается по первым восьми символам', async () => {
    support.findTicketByPrefix.mockResolvedValue({ id: TICKET, status: 'owner_handling' });

    await service.handleUpdate(update({
      text: `/ask Что с тикетом?`,
      reply_to_message: botReply(`Эскалация ${TICKET}`),
    }));

    expect(support.findTicketByPrefix).toHaveBeenCalledWith('11111111');
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({ ticketId: TICKET }));
  });

  it('/start и /status выполняют deterministic commands и отправляют их текст', async () => {
    await service.handleUpdate(update({ text: '/start' }, 1));
    await service.handleUpdate(update({ text: '/status' }, 2));

    expect(commands.start).toHaveBeenCalledTimes(1);
    expect(commands.status).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage.mock.calls.map((call) => call[1])).toEqual(['Справка', 'Сводка']);
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('/close принимает arg или #8hex из replied ticket, иначе показывает hint', async () => {
    await service.handleUpdate(update({ text: '/close #11111111' }, 1));
    await service.handleUpdate(update({
      text: '/close', reply_to_message: botReply('Эскалация #11111111'),
    }, 2));
    await service.handleUpdate(update({ text: '/close' }, 3));

    expect(commands.close).toHaveBeenNthCalledWith(1, '#11111111', {
      tgUserId: '200', adminUserId: 'admin-1',
    });
    expect(commands.close).toHaveBeenNthCalledWith(2, '#11111111', {
      tgUserId: '200', adminUserId: 'admin-1',
    });
    expect(commands.close).toHaveBeenCalledTimes(2);
    expect(telegram.sendMessage.mock.calls.some((call) => String(call[1]).includes('/close #'))).toBe(true);
  });

  it('/ask без текста даёт hint и не вызывает модель', async () => {
    await service.handleUpdate(update({ text: '/ask' }));

    expect(telegram.sendMessage.mock.calls[0][1]).toContain('/ask');
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('edited_message игнорируется, photo в private получает text-only, group non-text молчит', async () => {
    await service.handleUpdate({ update_id: 1, edited_message: update().message });
    await service.handleUpdate(update({ text: undefined, photo: [{ file_id: 'photo' }] }, 2));
    await service.handleUpdate(groupText(undefined, 3, { photo: [{ file_id: 'photo' }] }));

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith('100', 'Понимаю только текст', 10);
    expect(access.resolveTelegram).toHaveBeenCalledTimes(1);
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('duplicate message update_id обрабатывается один раз', async () => {
    store.claimUpdate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await service.handleUpdate(update({}, 7));
    await service.handleUpdate(update({}, 7));

    expect(store.claimUpdate).toHaveBeenCalledTimes(2);
    expect(access.resolveTelegram).toHaveBeenCalledTimes(1);
    expect(turns.enqueue).toHaveBeenCalledTimes(1);
  });

  it('duplicate callback update_id обрабатывается один раз', async () => {
    store.claimUpdate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    drafts.handleCallback.mockResolvedValue({ question: 'Вопрос', ticketId: TICKET });

    await service.handleUpdate(callback(`draft:${DRAFT}:ask`, {}, 8));
    await service.handleUpdate(callback(`draft:${DRAFT}:ask`, {}, 8));

    expect(drafts.handleCallback).toHaveBeenCalledTimes(1);
    expect(turns.enqueue).toHaveBeenCalledTimes(1);
  });

  it('valid draft callback делегирует drafts и enqueue возвращённый вопрос', async () => {
    drafts.handleCallback.mockResolvedValue({ question: 'Текст черновика', ticketId: TICKET });

    await service.handleUpdate(callback(`draft:${DRAFT}:ask`));

    expect(drafts.handleCallback).toHaveBeenCalledWith({
      callbackId: 'callback-1', chatId: '100', tgUserId: '200', adminUserId: 'admin-1',
      draftId: DRAFT, action: 'ask', messageId: 900,
    });
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      updateId: 1, chatId: '100', adminUserId: 'admin-1', question: 'Текст черновика',
      questionMessageId: 900, privateChat: true, ticketId: TICKET,
    }));
  });

  it.each(['send', 'cancel'])('valid admin callback %s проходит через service в drafts', async (action) => {
    drafts.handleCallback.mockResolvedValue({});

    await service.handleUpdate(callback(`draft:${DRAFT}:${action}`));

    expect(drafts.handleCallback).toHaveBeenCalledWith(expect.objectContaining({
      callbackId: 'callback-1', adminUserId: 'admin-1', draftId: DRAFT, action,
    }));
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('wrong chat и non-admin callback получают refusal без действия', async () => {
    await service.handleUpdate(callback(`draft:${DRAFT}:send`, {
      message: { message_id: 900, chat: { id: -100999, type: 'group' } },
    }, 1));
    access.resolveTelegram.mockResolvedValue({ userId: 'user-1', isAdmin: false });
    await service.handleUpdate(callback(`draft:${DRAFT}:send`, {}, 2));

    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(2);
    expect(drafts.handleCallback).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    'not-a-draft',
    `draft:not-a-uuid:ask`,
    `draft:${DRAFT}:delete`,
    `xdraft:${DRAFT}:ask`,
  ])('invalid callback data %s только безопасно ack', async (data) => {
    await service.handleUpdate(callback(data));

    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(access.resolveTelegram).not.toHaveBeenCalled();
    expect(drafts.handleCallback).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('channel отклоняется через alertBotAllowedChat', async () => {
    await service.handleUpdate(update({ chat: { id: -100123, type: 'channel' } }));

    expect(access.resolveTelegram).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('ошибка хранилища логируется только по kind, без текста сообщения', async () => {
    store.claimUpdate.mockRejectedValue(Object.assign(new Error('RAW-DB-SECRET'), { kind: 'db_down' }));

    await service.handleUpdate(update({ text: 'ВОПРОС-СЕКРЕТ' }));

    const logs = JSON.stringify(logger.error.mock.calls);
    expect(logs).toContain('db_down');
    expect(logs).not.toContain('RAW-DB-SECRET');
    expect(logs).not.toContain('ВОПРОС-СЕКРЕТ');
  });
});
