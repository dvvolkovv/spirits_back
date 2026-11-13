jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import { AlertBotService } from './alert-bot.service';

const TICKET = '11111111-1111-4111-8111-111111111111';
const DRAFT = '22222222-2222-4222-8222-222222222222';
const ADMIN = { userId: 'admin-1', isAdmin: true };
const GUARD_TOKEN = Symbol('draft-question-guard');

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
  const savedRepairAdmins = process.env.ALERT_BOT_REPAIR_ADMIN_TG_IDS;
  let access: { resolveTelegram: jest.Mock };
  let telegram: Record<string, jest.Mock>;
  let store: Record<string, jest.Mock>;
  let commands: Record<string, jest.Mock>;
  let drafts: Record<string, jest.Mock>;
  let turns: { enqueue: jest.Mock; resumeExisting: jest.Mock; stopAdmission: jest.Mock };
  let support: { findTicketByPrefix: jest.Mock };
  let repairs: { admit: jest.Mock; abandon: jest.Mock; stop: jest.Mock; stopAll: jest.Mock };
  let logger: { error: jest.Mock };
  let service: AlertBotService;

  beforeEach(() => {
    process.env.TELEGRAM_CHAT_ID = '-100123';
    process.env.ALERT_BOT_REPAIR_ADMIN_TG_IDS = '123';
    access = { resolveTelegram: jest.fn().mockResolvedValue(ADMIN) };
    telegram = {
      getMe: jest.fn().mockResolvedValue({ id: 999, username: 'linkeon_alert_bot' }),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1000 }),
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
    };
    store = {
      claimUpdate: jest.fn().mockResolvedValue(true),
      completeUpdate: jest.fn().mockResolvedValue(undefined),
      failUpdate: jest.fn().mockResolvedValue(false),
      dueUpdates: jest.fn().mockResolvedValue([]),
      requeueProcessingUpdates: jest.fn().mockResolvedValue(undefined),
      findTurnByAnswer: jest.fn().mockResolvedValue(null),
      findTurnByUpdate: jest.fn().mockResolvedValue(null),
    };
    commands = {
      start: jest.fn().mockResolvedValue('Справка'),
      status: jest.fn().mockResolvedValue('Сводка'),
      close: jest.fn().mockResolvedValue('✅ Тикет закрыт'),
    };
    drafts = {
      maybeDraft: jest.fn().mockResolvedValue(null),
      handleCallback: jest.fn().mockResolvedValue({}),
      finalizeAsk: jest.fn().mockResolvedValue(undefined),
      finishAsk: jest.fn(),
      releaseAsk: jest.fn().mockResolvedValue(undefined),
    };
    turns = {
      enqueue: jest.fn().mockResolvedValue('accepted'),
      resumeExisting: jest.fn().mockResolvedValue('accepted'),
      stopAdmission: jest.fn(),
    };
    support = { findTicketByPrefix: jest.fn().mockResolvedValue(null) };
    repairs = {
      admit: jest.fn().mockResolvedValue({ status: 'accepted', repairId: 'repair-1' }),
      abandon: jest.fn().mockResolvedValue(true),
      stop: jest.fn().mockResolvedValue('Исправление остановлено'),
      stopAll: jest.fn().mockResolvedValue(undefined),
    };
    logger = { error: jest.fn() };
    service = new AlertBotService(
      access as any,
      telegram as any,
      store as any,
      commands as any,
      drafts as any,
      turns as any,
      support as any,
      repairs as any,
    );
    (service as any).logger = logger;
  });

  afterEach(() => {
    if (savedChatIds === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = savedChatIds;
    if (savedRepairAdmins === undefined) delete process.env.ALERT_BOT_REPAIR_ADMIN_TG_IDS;
    else process.env.ALERT_BOT_REPAIR_ADMIN_TG_IDS = savedRepairAdmins;
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

  it('неуспешный refusal не включает часовой throttle и разрешает повторную отправку', async () => {
    access.resolveTelegram.mockResolvedValue({ userId: 'user-1', isAdmin: false });
    telegram.sendMessage
      .mockRejectedValueOnce(Object.assign(new Error('RAW-REFUSAL-SECRET'), { kind: 'send_failed' }))
      .mockResolvedValueOnce({ message_id: 1001 });

    await service.handleUpdate(update({}, 1));
    await service.handleUpdate(update({ text: 'Повторный вопрос' }, 2));

    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
    expect(telegram.sendMessage.mock.calls[1][1]).toContain('только для администраторов');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('RAW-REFUSAL-SECRET');
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

  it('reply человеку с #prefix и mention остаётся вопросом, а не ticket draft', async () => {
    support.findTicketByPrefix.mockResolvedValue({ id: TICKET, status: 'escalated' });

    await service.handleUpdate(groupText('@linkeon_alert_bot Разбери причину', 1, {
      reply_to_message: {
        message_id: 556,
        text: 'Эскалация #11111111',
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 201, is_bot: false },
      },
    }));

    expect(drafts.maybeDraft).not.toHaveBeenCalled();
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Разбери причину', replyText: 'Эскалация #11111111', privateChat: false,
    }));
    expect(turns.enqueue.mock.calls[0][0].ticketId).toBeUndefined();
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

  it('полный UUID в reply передаётся целиком, без рискованного prefix lookup', async () => {
    support.findTicketByPrefix.mockResolvedValue({ id: TICKET, status: 'owner_handling' });

    await service.handleUpdate(update({
      text: `/ask Что с тикетом?`,
      reply_to_message: botReply(`Эскалация ${TICKET}`),
    }));

    expect(support.findTicketByPrefix).toHaveBeenCalledWith(TICKET);
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({ ticketId: TICKET }));
  });

  it('ambiguous #8hex в reply не создаёт draft или model turn и просит полный UUID', async () => {
    support.findTicketByPrefix.mockRejectedValue(
      Object.assign(new Error('ambiguous'), { name: 'TicketPrefixAmbiguousError' }),
    );

    await service.handleUpdate(update({
      text: 'Ответ пользователю',
      reply_to_message: botReply('Эскалация #11111111'),
    }));

    expect(drafts.maybeDraft).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      '100', expect.stringContaining('полный UUID'), 10,
    );
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

  it('/fix от разрешённого Telegram admin создаёт repair и ставит его в общий turns queue', async () => {
    await service.handleUpdate(groupText('/fix почини файлы', 1, { from: { id: 123 } }));

    expect(repairs.admit).toHaveBeenCalledWith({
      updateId: 1,
      chatId: '-100123',
      adminTgId: '123',
      instruction: 'почини файлы',
    });
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      updateId: 1,
      chatId: '-100123',
      tgUserId: '123',
      adminUserId: 'admin-1',
      questionMessageId: 10,
      question: 'почини файлы',
      privateChat: false,
      mode: 'repair',
      repairId: 'repair-1',
    }));
  });

  it('/fix@linkeon_alert_bot распознаётся как repair command', async () => {
    await service.handleUpdate(groupText('/fix@linkeon_alert_bot почини файлы', 1, { from: { id: 123 } }));

    expect(repairs.admit).toHaveBeenCalledWith(expect.objectContaining({ instruction: 'почини файлы' }));
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({ mode: 'repair' }));
  });

  it.each(['исправь файлы', 'почини файлы'])('%s в reply боту запускает repair', async (text) => {
    await service.handleUpdate(groupText(text, 1, {
      from: { id: 123 },
      reply_to_message: { ...botReply('Диагноз'), chat: { id: -100123, type: 'supergroup' } },
    }));

    expect(repairs.admit).toHaveBeenCalledWith(expect.objectContaining({ instruction: text }));
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({ mode: 'repair' }));
  });

  it('repair phrase без reply в группе не запускает ни repair, ни read-only turn', async () => {
    await service.handleUpdate(groupText('почини файлы', 1, { from: { id: 123 } }));

    expect(repairs.admit).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('non-admin в разрешённой группе получает refusal без repair или turn', async () => {
    await service.handleUpdate(groupText('/fix почини файлы', 1, { from: { id: 999 } }));

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      '-100123', expect.stringContaining('только для администраторов'), 10,
    );
    expect(repairs.admit).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
    expect(access.resolveTelegram).not.toHaveBeenCalled();
  });

  it.each([
    [{ from: { id: 999, username: '123' } }],
    [{ from: { id: 999 }, forward_from: { id: 123 } }],
  ])('username или forwarded admin не даёт права на repair', async (overrides) => {
    await service.handleUpdate(groupText('/fix почини файлы', 1, overrides));

    expect(repairs.admit).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      '-100123', expect.stringContaining('только для администраторов'), 10,
    );
  });

  it('пустой repair allowlist отключает /fix даже для числового admin id', async () => {
    process.env.ALERT_BOT_REPAIR_ADMIN_TG_IDS = '';

    await service.handleUpdate(groupText('/fix почини файлы', 1, { from: { id: 123 } }));

    expect(repairs.admit).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      '-100123', expect.stringContaining('только для администраторов'), 10,
    );
  });

  it('repair admin без Linkeon link допускается по Telegram id с synthetic adminUserId', async () => {
    access.resolveTelegram.mockResolvedValue({ userId: null, isAdmin: false });

    await service.handleUpdate(groupText('/fix почини файлы', 1, { from: { id: 123 } }));

    expect(access.resolveTelegram).toHaveBeenCalledWith(123);
    expect(repairs.admit).toHaveBeenCalledTimes(1);
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      tgUserId: '123', adminUserId: 'tg:123', mode: 'repair', repairId: 'repair-1',
    }));
  });

  it('/fix без задачи показывает hint и не создаёт repair', async () => {
    await service.handleUpdate(groupText('/fix', 1, { from: { id: 123 } }));

    expect(telegram.sendMessage.mock.calls[0][1]).toContain('/fix');
    expect(repairs.admit).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('/stop разрешённого admin делегирует repairs.stop и отправляет результат', async () => {
    await service.handleUpdate(groupText('/stop', 1, { from: { id: 123 } }));

    expect(repairs.stop).toHaveBeenCalledWith('-100123', '123');
    expect(telegram.sendMessage).toHaveBeenCalledWith('-100123', 'Исправление остановлено', 10);
    expect(repairs.admit).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('/stop non-admin не вызывает mutation', async () => {
    await service.handleUpdate(groupText('/stop', 1, { from: { id: 999 } }));

    expect(repairs.stop).not.toHaveBeenCalled();
    expect(repairs.admit).not.toHaveBeenCalled();
    expect(repairs.abandon).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('non-admin callback не вызывает repair или draft mutation', async () => {
    access.resolveTelegram.mockResolvedValue({ userId: 'user-999', isAdmin: false });

    await service.handleUpdate(callback(`draft:${DRAFT}:send`, { from: { id: 999 } }));

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Доступ только для администраторов');
    expect(drafts.handleCallback).not.toHaveBeenCalled();
    expect(repairs.stop).not.toHaveBeenCalled();
    expect(repairs.admit).not.toHaveBeenCalled();
    expect(repairs.abandon).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('busy repair admission сообщает о другом исправлении и не создаёт turn', async () => {
    repairs.admit.mockResolvedValue({ status: 'busy' });

    await service.handleUpdate(groupText('/fix почини файлы', 1, { from: { id: 123 } }));

    expect(telegram.sendMessage).toHaveBeenCalledWith(
      '-100123', 'Другое исправление уже выполняется в этом чате', 10,
    );
    expect(turns.enqueue).not.toHaveBeenCalled();
    expect(repairs.abandon).not.toHaveBeenCalled();
  });

  it.each(['busy', 'rate_limited'])('turns admission %s отменяет только что созданный requested repair', async (status) => {
    turns.enqueue.mockResolvedValue(status);

    await service.handleUpdate(groupText('/fix почини файлы', 1, { from: { id: 123 } }));

    expect(repairs.abandon).toHaveBeenCalledWith('repair-1');
  });

  it('неуспешный abandon после turns admission журналируется без instruction', async () => {
    turns.enqueue.mockResolvedValue('busy');
    repairs.abandon.mockResolvedValue(false);

    await service.handleUpdate(groupText('/fix СЕКРЕТНАЯ-ЗАДАЧА', 1, { from: { id: 123 } }));

    expect(repairs.abandon).toHaveBeenCalledWith('repair-1');
    expect(logger.error).toHaveBeenCalledWith('alert-bot repair abandon failed kind=admission_cleanup');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('СЕКРЕТНАЯ-ЗАДАЧА');
  });

  it.each(['busy', 'rate_limited'])('turns admission %s не отменяет existing repair', async (status) => {
    repairs.admit.mockResolvedValue({ status: 'existing', repairId: 'repair-existing' });
    turns.enqueue.mockResolvedValue(status);

    await service.handleUpdate(groupText('/fix почини файлы', 1, { from: { id: 123 } }));

    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({ repairId: 'repair-existing' }));
    expect(repairs.abandon).not.toHaveBeenCalled();
  });

  it.each([
    ['accepted'],
    ['existing'],
  ])('ошибка turns.enqueue сохраняет requested repair для retry при admission=%s', async (status) => {
    repairs.admit.mockResolvedValue({ status, repairId: 'repair-1' });
    turns.enqueue.mockRejectedValue(Object.assign(new Error('RAW-ENQUEUE-SECRET'), { kind: 'db_down' }));

    await service.handleUpdate(groupText('/fix почини файлы', 1, { from: { id: 123 } }));

    expect(repairs.abandon).not.toHaveBeenCalled();
    expect(store.failUpdate).toHaveBeenCalledWith(1, 'db_down');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('RAW-ENQUEUE-SECRET');
  });

  it('duplicate update не создаёт второй repair', async () => {
    store.claimUpdate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const duplicate = groupText('/fix почини файлы', 7, { from: { id: 123 } });

    await service.handleUpdate(duplicate);
    await service.handleUpdate(duplicate);

    expect(repairs.admit).toHaveBeenCalledTimes(1);
    expect(turns.enqueue).toHaveBeenCalledTimes(1);
  });

  it('repair reply на подтверждённый диагноз бота передаёт parentTurnId и replyText', async () => {
    store.findTurnByAnswer.mockResolvedValue({ id: 'parent-diagnosis', status: 'ok' });

    await service.handleUpdate(update({
      text: 'почини',
      from: { id: 123 },
      reply_to_message: botReply('Причина подтверждена'),
    }));

    expect(store.findTurnByAnswer).toHaveBeenCalledWith('100', 555);
    expect(store.findTurnByAnswer).toHaveBeenCalledTimes(1);
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'repair',
      repairId: 'repair-1',
      parentTurnId: 'parent-diagnosis',
      replyText: 'Причина подтверждена',
    }));
  });

  it.each([
    ['help', null],
    ['status', null],
    ['busy', { id: 'parent-busy', status: 'busy' }],
    ['unrelated', null],
  ])('repair phrase на %s без подтверждённого diagnosis не запускает turn', async (_kind, parent) => {
    store.findTurnByAnswer.mockResolvedValue(parent);

    await service.handleUpdate(update({
      text: 'почини',
      from: { id: 123 },
      reply_to_message: botReply('Служебный ответ'),
    }));

    expect(store.findTurnByAnswer).toHaveBeenCalledTimes(1);
    expect(repairs.admit).not.toHaveBeenCalled();
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('/fix остаётся доступен по явной задаче даже без подтверждённого parent', async () => {
    store.findTurnByAnswer.mockResolvedValue(null);

    await service.handleUpdate(update({
      text: '/fix почини файлы',
      from: { id: 123 },
      reply_to_message: botReply('Справка'),
    }));

    expect(repairs.admit).toHaveBeenCalledWith(expect.objectContaining({ instruction: 'почини файлы' }));
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({ mode: 'repair' }));
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
    drafts.handleCallback.mockResolvedValue({
      question: 'Вопрос', ticketId: TICKET, draftId: DRAFT, claimVersion: 1, guardToken: GUARD_TOKEN,
    });

    await service.handleUpdate(callback(`draft:${DRAFT}:ask`, {}, 8));
    await service.handleUpdate(callback(`draft:${DRAFT}:ask`, {}, 8));

    expect(drafts.handleCallback).toHaveBeenCalledTimes(1);
    expect(turns.enqueue).toHaveBeenCalledTimes(1);
  });

  it('valid draft callback делегирует drafts и enqueue возвращённый вопрос', async () => {
    drafts.handleCallback.mockResolvedValue({
      question: 'Текст черновика', ticketId: TICKET, draftId: DRAFT, claimVersion: 3, guardToken: GUARD_TOKEN,
    });

    await service.handleUpdate(callback(`draft:${DRAFT}:ask`));

    expect(drafts.handleCallback).toHaveBeenCalledWith({
      callbackId: 'callback-1', chatId: '100', tgUserId: '200', adminUserId: 'admin-1',
      draftId: DRAFT, action: 'ask', messageId: 900, internalRetry: false,
    });
    expect(turns.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      updateId: 1, chatId: '100', adminUserId: 'admin-1', question: 'Текст черновика',
      questionMessageId: 900, privateChat: true, ticketId: TICKET,
    }), { draftId: DRAFT, claimVersion: 3 }, expect.objectContaining({ onAdmission: expect.any(Function) }));
    expect(drafts.finalizeAsk).not.toHaveBeenCalled();
    expect(drafts.finishAsk).toHaveBeenCalledWith(DRAFT, GUARD_TOKEN);
    expect(drafts.releaseAsk).not.toHaveBeenCalled();
  });

  it.each(['busy', 'rate_limited', 'stale'])('draft ask при admission %s освобождает только совпавший резерв', async (admission) => {
    drafts.handleCallback.mockResolvedValue({
      question: 'Текст черновика', ticketId: TICKET, draftId: DRAFT, claimVersion: 4, guardToken: GUARD_TOKEN,
    });
    turns.enqueue.mockResolvedValue(admission);

    await service.handleUpdate(callback(`draft:${DRAFT}:ask`));

    expect(drafts.releaseAsk).toHaveBeenCalledWith(DRAFT, 4);
    expect(drafts.finishAsk).toHaveBeenCalledWith(DRAFT, GUARD_TOKEN);
    expect(turns.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      { draftId: DRAFT, claimVersion: 4 },
      expect.objectContaining({ onAdmission: expect.any(Function) }),
    );
    expect(drafts.finalizeAsk).not.toHaveBeenCalled();
  });

  it('draft ask при сбое enqueue освобождает резерв для retry', async () => {
    drafts.handleCallback.mockResolvedValue({
      question: 'Текст черновика', ticketId: TICKET, draftId: DRAFT, claimVersion: 5, guardToken: GUARD_TOKEN,
    });
    turns.enqueue.mockRejectedValue(Object.assign(new Error('RAW-ADMISSION-SECRET'), { kind: 'db_down' }));

    await service.handleUpdate(callback(`draft:${DRAFT}:ask`));

    expect(drafts.releaseAsk).toHaveBeenCalledWith(DRAFT, 5);
    expect(drafts.finishAsk).toHaveBeenCalledWith(DRAFT, GUARD_TOKEN);
    expect(drafts.finalizeAsk).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('RAW-ADMISSION-SECRET');
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

  it('alreadyClaimed webhook update не делает второй durable claim', async () => {
    await (service as any).handleUpdate(update(), true);

    expect(store.claimUpdate).not.toHaveBeenCalled();
    expect(turns.enqueue).toHaveBeenCalledTimes(1);
    expect(store.completeUpdate).toHaveBeenCalledWith(1);
  });

  it('periodic retry сначала рекуеит только stale processing, затем читает due failed', async () => {
    await service.retryFailedUpdates();

    expect(store.requeueProcessingUpdates).toHaveBeenCalledWith(60);
    expect(store.dueUpdates).toHaveBeenCalledTimes(1);
    expect(store.requeueProcessingUpdates.mock.invocationCallOrder[0]).toBeLessThan(
      store.dueUpdates.mock.invocationCallOrder[0],
    );
  });

  it('stopAdmission ждёт завершения repairs.stopAll', async () => {
    let finishStop!: () => void;
    repairs.stopAll.mockImplementation(() => new Promise<void>((resolve) => { finishStop = resolve; }));
    let completed = false;

    const stopping = Promise.resolve(service.stopAdmission()).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    finishStop();
    await stopping;
    expect(completed).toBe(true);
    expect(repairs.stopAll).toHaveBeenCalledTimes(1);
  });

  it('shutdown возвращает stopped для новых claim и не запускает scheduled retry', async () => {
    await service.stopAdmission();

    expect(repairs.stopAll).toHaveBeenCalledTimes(1);
    await expect(service.claimUpdate(update({}, 10))).resolves.toBe('stopped');
    await service.retryFailedUpdates();
    expect(store.claimUpdate).not.toHaveBeenCalled();
    expect(store.requeueProcessingUpdates).not.toHaveBeenCalled();
    expect(store.dueUpdates).not.toHaveBeenCalled();
  });

  it('claimed → stop → late enqueue оставляет durable retry и не создаёт turn', async () => {
    let resolveAccess!: (value: typeof ADMIN) => void;
    access.resolveTelegram.mockImplementation(() => new Promise<typeof ADMIN>((resolve) => { resolveAccess = resolve; }));
    const handling = service.handleUpdate(update({}, 11), true);
    for (let i = 0; i < 20 && access.resolveTelegram.mock.calls.length === 0; i += 1) await Promise.resolve();

    await service.stopAdmission();
    resolveAccess(ADMIN);
    await handling;

    expect(turns.enqueue).not.toHaveBeenCalled();
    expect(store.completeUpdate).not.toHaveBeenCalled();
    expect(store.failUpdate).toHaveBeenCalledWith(11, 'stopped');
  });

  it('internal retry при active draft claim остаётся failed, fresh duplicate завершается без второй публикации', async () => {
    drafts.handleCallback.mockImplementation((input: any) => {
      if (input.internalRetry) throw Object.assign(new Error('active'), { kind: 'draft_in_progress' });
      return {};
    });
    store.dueUpdates.mockResolvedValue([{ updateId: 1, payload: callback(`draft:${DRAFT}:send`) }]);

    await service.retryFailedUpdates();

    expect(store.completeUpdate).not.toHaveBeenCalled();
    expect(store.failUpdate).toHaveBeenCalledWith(1, 'draft_in_progress');
    expect(drafts.handleCallback).toHaveBeenCalledWith(expect.objectContaining({ internalRetry: true }));
  });

  it.each([
    ['accepted', 'Вопрос принят'],
    ['queued', 'Вопрос поставлен в очередь'],
    ['busy', 'Занят, спросите через минуту'],
    ['rate_limited', 'Лимит вопросов в час исчерпан'],
    ['stale', 'Черновик устарел'],
  ])('draft ask ack после admission %s имеет соответствующий текст', async (admission, text) => {
    drafts.handleCallback.mockResolvedValue({
      question: 'Текст черновика', ticketId: TICKET, draftId: DRAFT, claimVersion: 3, guardToken: GUARD_TOKEN,
    });
    turns.enqueue.mockImplementation(async (_input, _reservation, options) => {
      await options.onAdmission(admission);
      return admission;
    });

    await service.handleUpdate(callback(`draft:${DRAFT}:ask`));

    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', text);
  });

  it('draft ask ack приходит по onAdmission до завершения delivery', async () => {
    let resolveDelivery!: (value: 'accepted') => void;
    turns.enqueue.mockImplementation(async (_input, _reservation, options) => {
      await options.onAdmission('accepted');
      return new Promise<'accepted'>((resolve) => { resolveDelivery = resolve; });
    });
    drafts.handleCallback.mockResolvedValue({
      question: 'Текст черновика', ticketId: TICKET, draftId: DRAFT, claimVersion: 3, guardToken: GUARD_TOKEN,
    });

    const handling = service.handleUpdate(callback(`draft:${DRAFT}:ask`));
    for (let i = 0; i < 20 && telegram.answerCallbackQuery.mock.calls.length === 0; i += 1) await Promise.resolve();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith('callback-1', 'Вопрос принят');
    expect(store.completeUpdate).not.toHaveBeenCalled();

    for (let i = 0; i < 20 && !resolveDelivery; i += 1) await Promise.resolve();
    resolveDelivery('accepted');
    await handling;
    expect(store.completeUpdate).toHaveBeenCalledWith(1);
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
