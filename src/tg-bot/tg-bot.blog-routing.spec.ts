import { TgBotService, shouldRouteToBlog } from './tg-bot.service';

describe('shouldRouteToBlog', () => {
  it('callback с префиксом blog: уходит в блог', () => {
    expect(shouldRouteToBlog('blog:ok:p1')).toBe(true);
  });

  it('callback ассистента не уходит в блог', () => {
    expect(shouldRouteToBlog('agent:5')).toBe(false);
    expect(shouldRouteToBlog('lang:ru')).toBe(false);
    expect(shouldRouteToBlog('agents_page:1')).toBe(false);
  });

  it('пустые данные не уходят в блог', () => {
    expect(shouldRouteToBlog('')).toBe(false);
    expect(shouldRouteToBlog(undefined as any)).toBe(false);
  });
});

/**
 * Хелпер выше — чистая функция, и сам по себе он ничего не доказывает:
 * порядок врезки в живом роутере ею не проверяется. Тесты ниже проверяют
 * именно порядок, потому что обе врезки опасны ровно порядком:
 *
 *  - кнопка блога обязана уйти в блог ДО `if (!ownerId) return` — владелец
 *    блога определяется не через связку ассистентов, и проверка привязки
 *    молча проглотила бы нажатие;
 *  - реплай, который блог НЕ признал своим, обязан уйти ассистенту, иначе
 *    врезка ломает людям обычный чат.
 */
describe('роутинг блога в живом обработчике', () => {
  const identity = { getLinkeonIdByTgUserId: jest.fn() };
  const configs = { ensurePrivateConfig: jest.fn(), getActiveByTgChatId: jest.fn() };
  const commands = { handleAgentCallback: jest.fn(), handleLanguageCallback: jest.fn(), handleAssistants: jest.fn() };
  const grammy = { sendMessage: jest.fn() };
  const blog = { handleCallback: jest.fn(), handleReplyEdit: jest.fn() };
  const pg = { query: jest.fn() };

  const svc = new TgBotService(
    pg as any,
    identity as any,
    {} as any, // claim
    configs as any,
    {} as any, // router
    {} as any, // voice
    {} as any, // billing
    commands as any,
    {} as any, // meetings
    grammy as any,
    {} as any, // misc
    {} as any, // video
    blog as any,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    pg.query.mockResolvedValue({ rows: [] });
    (svc as any).handleChatMessage = jest.fn();
  });

  it('кнопка блога уходит в блог даже у непривязанного к Linkeon пользователя', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue(null);
    blog.handleCallback.mockResolvedValue(true);

    const cb = { id: 'cb1', data: 'blog:ok:p1', from: { id: 42 }, message: { chat: { id: 777 } } };
    await (svc as any).handleCallbackQuery(cb);

    expect(blog.handleCallback).toHaveBeenCalledWith(cb);
  });

  it('кнопка ассистента в блог не уходит', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');

    await (svc as any).handleCallbackQuery({
      id: 'cb2',
      data: 'agent:5',
      from: { id: 42 },
      message: { chat: { id: 777 } },
    });

    expect(blog.handleCallback).not.toHaveBeenCalled();
    expect(commands.handleAgentCallback).toHaveBeenCalled();
  });

  const replyMsg = () => ({
    chat: { id: 777, type: 'private' },
    from: { id: 42 },
    message_id: 10,
    reply_to_message: { message_id: 5 },
    text: 'новый текст поста',
  });

  it('реплай на черновик блога не уходит ассистенту', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');
    configs.ensurePrivateConfig.mockResolvedValue({ id: 'cfg-1' });
    blog.handleReplyEdit.mockResolvedValue(true);

    await (svc as any).handleMessage(replyMsg());

    expect((svc as any).handleChatMessage).not.toHaveBeenCalled();
  });

  it('чужой реплай блог не перехватывает — текст идёт ассистенту', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');
    configs.ensurePrivateConfig.mockResolvedValue({ id: 'cfg-1' });
    blog.handleReplyEdit.mockResolvedValue(false);

    await (svc as any).handleMessage(replyMsg());

    expect((svc as any).handleChatMessage).toHaveBeenCalled();
  });

  it('команда реплаем остаётся командой, блог её не видит', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');
    blog.handleReplyEdit.mockResolvedValue(false);
    (svc as any).handleDmCommand = jest.fn();

    await (svc as any).handleMessage({ ...replyMsg(), text: '/balance' });

    expect((svc as any).handleDmCommand).toHaveBeenCalled();
    expect(blog.handleReplyEdit).not.toHaveBeenCalled();
  });
});
