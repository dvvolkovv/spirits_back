import { TgBotService } from './tg-bot.service';

/**
 * `/youtube` — пульт владельца роликов на YouTube (режимы, аварийное
 * «вручную»); как и `/case`, `/short` — до разбора команд в handleDmCommand
 * (ревью задачи 9: без этого файла удаление строки
 * `if (await this.shortsYoutube?.handleCommand(msg)) return;` осталось бы
 * зелёным — сервис @Optional, разрыв связки молчит).
 */
describe('/youtube в живом обработчике', () => {
  const identity = { getLinkeonIdByTgUserId: jest.fn() };
  const blog = { handleCaseCommand: jest.fn() };
  const grammy = { sendMessage: jest.fn(), answerCallbackQuery: jest.fn() };
  const pg = { query: jest.fn() };

  // YouTube — 18-м (последним) аргументом, как в tg-bot.service.ts: claim,
  // configs, router, voice, billing, commands, meetings, misc, video — не
  // нужны этим тестам, costGrowth/insights/shortsApproval/productActionsTg
  // пропущены как undefined.
  const build = (youtube?: any) =>
    new TgBotService(
      pg as any, identity as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, grammy as any, {} as any, {} as any, blog as any,
      undefined, undefined, undefined, undefined, youtube,
    );

  beforeEach(() => {
    jest.resetAllMocks();
    pg.query.mockResolvedValue({ rows: [] });
    blog.handleCaseCommand.mockResolvedValue(false);
  });

  it('/youtube владельца забирают ролики — ответа про неизвестную команду нет', async () => {
    const youtube = { handleCommand: jest.fn().mockResolvedValue(true) };
    const svc = build(youtube);
    const msg = { chat: { id: 37948399, type: 'private' }, from: { id: 37948399 }, text: '/youtube' };

    await (svc as any).handleDmCommand(msg);

    expect(youtube.handleCommand).toHaveBeenCalledWith(msg);
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('чужой /youtube ролики не берут — бот отвечает как на неизвестную команду, как для /short', async () => {
    const youtube = { handleCommand: jest.fn().mockResolvedValue(false) };
    const svc = build(youtube);

    await (svc as any).handleDmCommand({ chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/youtube' });

    expect(grammy.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('Не знаю такой команды'));
  });

  it('сервиса нет — /youtube отвечает как неизвестная команда, без исключения', async () => {
    const svc = build(undefined);

    await expect(
      (svc as any).handleDmCommand({ chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/youtube' }),
    ).resolves.toBeUndefined();
    expect(grammy.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('Не знаю такой команды'));
  });
});

/**
 * Порванная связка: сервис не подставлен, но ролики включены флагом — тишина
 * здесь означала бы, что никто не узнает, почему /youtube молчит. Образец —
 * те же два теста для ShortsApprovalService в tg-bot.shorts-routing.spec.ts.
 */
describe('TgBotService.onModuleInit — порванная связка с YouTube', () => {
  const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const prevEnabled = process.env.SHORTS_ENABLED;

  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.SHORTS_ENABLED;
    else process.env.SHORTS_ENABLED = prevEnabled;
  });

  const buildWith = (youtube?: any) =>
    new TgBotService(
      pg as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      undefined, undefined, undefined, undefined, youtube,
    );

  it('SHORTS_ENABLED=true и ShortsYoutubeService не подставлен — предупреждение в лог', async () => {
    process.env.SHORTS_ENABLED = 'true';
    const svc = buildWith(undefined);
    jest.spyOn(svc as any, 'applyMigration').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'pruneWorkspaces').mockResolvedValue(undefined);
    const warn = jest.spyOn((svc as any).logger, 'warn');
    await svc.onModuleInit();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ShortsYoutubeService не подставлен'));
  });

  it('ShortsYoutubeService подставлен — предупреждения нет', async () => {
    process.env.SHORTS_ENABLED = 'true';
    const svc = buildWith({ handleCommand: jest.fn() });
    jest.spyOn(svc as any, 'applyMigration').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'pruneWorkspaces').mockResolvedValue(undefined);
    const warn = jest.spyOn((svc as any).logger, 'warn');
    await svc.onModuleInit();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('ShortsYoutubeService не подставлен'));
  });
});
