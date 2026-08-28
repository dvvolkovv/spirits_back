import { TgBotService } from './tg-bot.service';

/**
 * До этой правки в приватном чате обрабатывались только /start и команды:
 * обычный текст не попадал никуда, бот молчал. Вызываем handleMessage
 * напрямую, а не handleUpdate — тот глотает исключения, и падение теста
 * выглядело бы как «просто не вызвалось».
 */
describe('обычный текст в личном чате', () => {
  const identity = { getLinkeonIdByTgUserId: jest.fn() };
  const configs = { ensurePrivateConfig: jest.fn(), getActiveByTgChatId: jest.fn() };
  const grammy = { sendMessage: jest.fn() };

  const svc = new TgBotService(
    {} as any, // pg
    identity as any,
    {} as any, // claim
    configs as any,
    {} as any, // router
    {} as any, // voice
    {} as any, // billing
    {} as any, // commands
    grammy as any,
    {} as any, // misc
    {} as any, // video
  );

  beforeEach(() => {
    jest.resetAllMocks();
    (svc as any).handleChatMessage = jest.fn();
    (svc as any).handleDmCommand = jest.fn();
  });

  const msg = (text: string) => ({
    chat: { id: 777, type: 'private' },
    from: { id: 42 },
    message_id: 1,
    text,
  });

  it('текст от привязанного пользователя уходит в общий обработчик', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');
    configs.ensurePrivateConfig.mockResolvedValue({ id: 'cfg-1' });

    await (svc as any).handleMessage(msg('привет'));

    expect(configs.ensurePrivateConfig).toHaveBeenCalledWith('u-1', 777);
    expect((svc as any).handleChatMessage).toHaveBeenCalled();
  });

  it('непривязанный пользователь получает подсказку, а не молчание', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue(null);

    await (svc as any).handleMessage(msg('привет'));

    expect((svc as any).handleChatMessage).not.toHaveBeenCalled();
    expect(grammy.sendMessage).toHaveBeenCalledWith(777, expect.stringContaining('/start'));
  });

  it('команды по-прежнему идут своим путём, не в ассистента', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');

    await (svc as any).handleMessage(msg('/balance'));

    expect((svc as any).handleDmCommand).toHaveBeenCalled();
    expect((svc as any).handleChatMessage).not.toHaveBeenCalled();
  });
});
