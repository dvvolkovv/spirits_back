import { TgBotService, shouldRouteToShorts } from './tg-bot.service';

describe('shouldRouteToShorts', () => {
  it('short: — в ролики, остальное — нет', () => {
    expect(shouldRouteToShorts('short:ok:x')).toBe(true);
    expect(shouldRouteToShorts('blog:ok:x')).toBe(false);
    expect(shouldRouteToShorts('shortcut')).toBe(false);
    expect(shouldRouteToShorts(undefined)).toBe(false);
  });
});

/**
 * Порядок врезок — тот же, что у блога (tg-bot.blog-routing.spec.ts): кнопка
 * роликов — до проверки привязки; реплай, который не узнали ни блог, ни
 * ролики, — ассистенту; `/short` — до разбора команд.
 */
describe('роутинг роликов в живом обработчике', () => {
  const identity = { getLinkeonIdByTgUserId: jest.fn() };
  const configs = { ensurePrivateConfig: jest.fn(), getActiveByTgChatId: jest.fn() };
  const commands = { handleAgentCallback: jest.fn(), handleLanguageCallback: jest.fn(), handleAssistants: jest.fn() };
  const grammy = { sendMessage: jest.fn(), answerCallbackQuery: jest.fn() };
  const blog = { handleCallback: jest.fn(), handleReplyEdit: jest.fn(), handleCaseCommand: jest.fn() };
  const shorts = { handleCallback: jest.fn(), handleReplyEdit: jest.fn(), handleShortCommand: jest.fn() };
  const pg = { query: jest.fn() };
  const build = (withShorts: boolean) =>
    new TgBotService(
      pg as any, identity as any, {} as any, configs as any, {} as any, {} as any, {} as any,
      commands as any, {} as any, grammy as any, {} as any, {} as any, blog as any,
      undefined, withShorts ? (shorts as any) : undefined,
    );
  const svc = build(true);

  beforeEach(() => {
    jest.resetAllMocks();
    pg.query.mockResolvedValue({ rows: [] });
    grammy.answerCallbackQuery.mockResolvedValue(true);
    (svc as any).handleChatMessage = jest.fn();
  });

  it('кнопка ролика уходит в ролики даже у непривязанного', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue(null);
    const cb = { id: 'cb', data: 'short:ok:6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10', from: { id: 42 }, message: { chat: { id: 777 } } };
    await (svc as any).handleCallbackQuery(cb);
    expect(shorts.handleCallback).toHaveBeenCalledWith(cb);
    expect(blog.handleCallback).not.toHaveBeenCalled();
  });

  it('кнопка блога в ролики не уходит', async () => {
    await (svc as any).handleCallbackQuery({ id: 'cb', data: 'blog:ok:p1', from: { id: 42 }, message: { chat: { id: 777 } } });
    expect(blog.handleCallback).toHaveBeenCalled();
    expect(shorts.handleCallback).not.toHaveBeenCalled();
  });

  const replyMsg = () => ({
    chat: { id: 777, type: 'private' }, from: { id: 42 }, message_id: 10, reply_to_message: { message_id: 5 }, text: 'короче',
  });

  it('реплай, который узнали ролики, ассистенту не уходит', async () => {
    blog.handleReplyEdit.mockResolvedValue(false);
    shorts.handleReplyEdit.mockResolvedValue(true);
    await (svc as any).handleMessage(replyMsg());
    expect((svc as any).handleChatMessage).not.toHaveBeenCalled();
  });

  it('блог узнал реплай первым — ролики его не видят', async () => {
    blog.handleReplyEdit.mockResolvedValue(true);
    await (svc as any).handleMessage(replyMsg());
    expect(shorts.handleReplyEdit).not.toHaveBeenCalled();
  });

  it('ни блог, ни ролики не узнали — текст ассистенту', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');
    configs.ensurePrivateConfig.mockResolvedValue({ id: 'cfg-1' });
    blog.handleReplyEdit.mockResolvedValue(false);
    shorts.handleReplyEdit.mockResolvedValue(false);
    await (svc as any).handleMessage(replyMsg());
    expect((svc as any).handleChatMessage).toHaveBeenCalled();
  });

  it('/short владельца забирают ролики — ответа про неизвестную команду нет', async () => {
    blog.handleCaseCommand.mockResolvedValue(false);
    shorts.handleShortCommand.mockResolvedValue(true);
    await (svc as any).handleDmCommand({ chat: { id: 777, type: 'private' }, from: { id: 777 }, text: '/short тема ролика' });
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('без сервиса роликов кнопка гасит часики и не падает', async () => {
    const bare = build(false);
    await (bare as any).handleCallbackQuery({ id: 'cb', data: 'short:ok:x', from: { id: 42 }, message: { chat: { id: 777 } } });
    expect(grammy.answerCallbackQuery).toHaveBeenCalledWith('cb', {});
  });

  /**
   * Кнопка ролика не остаётся без ответа: handleCallback сервиса либо отвечает
   * сам (true — часики гасит он), либо нет (false/исключение) — и тогда часики
   * гасит бот, тем же способом, что и при отсутствующем сервисе выше.
   */
  describe('кнопка ролика не остаётся без ответа', () => {
    const cb = { id: 'cb', data: 'short:ok:x', from: { id: 42 }, message: { chat: { id: 777 } } };

    it('handleCallback бросил исключение — часики гасит бот, исключение не выходит наружу', async () => {
      shorts.handleCallback.mockRejectedValue(new Error('боль'));
      await expect((svc as any).handleCallbackQuery(cb)).resolves.toBeUndefined();
      expect(grammy.answerCallbackQuery).toHaveBeenCalledWith('cb', {});
    });

    it('handleCallback вернул false — часики гасит бот', async () => {
      shorts.handleCallback.mockResolvedValue(false);
      await (svc as any).handleCallbackQuery(cb);
      expect(grammy.answerCallbackQuery).toHaveBeenCalledWith('cb', {});
    });

    it('handleCallback вернул true — бот повторно часики не гасит (сервис отвечает сам)', async () => {
      shorts.handleCallback.mockResolvedValue(true);
      await (svc as any).handleCallbackQuery(cb);
      expect(grammy.answerCallbackQuery).not.toHaveBeenCalled();
    });
  });
});

/**
 * Порванная связка: сервис не подставлен, но ролики включены флагом — тишина
 * здесь означала бы, что никто не узнает, почему кнопки и /short молчат.
 */
describe('TgBotService.onModuleInit — порванная связка с роликами', () => {
  const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const prevEnabled = process.env.SHORTS_ENABLED;

  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.SHORTS_ENABLED;
    else process.env.SHORTS_ENABLED = prevEnabled;
  });

  const buildBare = () =>
    new TgBotService(
      pg as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      undefined, undefined,
    );

  it('SHORTS_ENABLED=true и сервис не подставлен — предупреждение в лог', async () => {
    process.env.SHORTS_ENABLED = 'true';
    const svc = buildBare();
    jest.spyOn(svc as any, 'applyMigration').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'pruneWorkspaces').mockResolvedValue(undefined);
    const warn = jest.spyOn((svc as any).logger, 'warn');
    await svc.onModuleInit();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ShortsApprovalService не подставлен'),
    );
  });

  it('SHORTS_ENABLED не true — предупреждения нет', async () => {
    delete process.env.SHORTS_ENABLED;
    const svc = buildBare();
    jest.spyOn(svc as any, 'applyMigration').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'pruneWorkspaces').mockResolvedValue(undefined);
    const warn = jest.spyOn((svc as any).logger, 'warn');
    await svc.onModuleInit();
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('ShortsApprovalService не подставлен'),
    );
  });
});
