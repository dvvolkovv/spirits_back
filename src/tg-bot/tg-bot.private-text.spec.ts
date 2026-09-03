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

  const pg = { query: jest.fn() };
  const svc = new TgBotService(
    pg as any,
    identity as any,
    {} as any, // claim
    configs as any,
    {} as any, // router
    {} as any, // voice
    {} as any, // billing
    {} as any, // commands
    {} as any, // meetings
    grammy as any,
    {} as any, // misc
    {} as any, // video
  );

  beforeEach(() => {
    jest.resetAllMocks();
    pg.query.mockResolvedValue({ rows: [{ preferred_agent: 'Кира' }] });
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
    expect(grammy.sendMessage).toHaveBeenCalled();
  });

  it('команды по-прежнему идут своим путём, не в ассистента', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');

    await (svc as any).handleMessage(msg('/balance'));

    expect((svc as any).handleDmCommand).toHaveBeenCalled();
    expect((svc as any).handleChatMessage).not.toHaveBeenCalled();
  });

  it('/start у привязанного: здоровается и называет ассистента, а не зовёт подключаться', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue('u-1');

    await (svc as any).handleMessage(msg('/start'));

    const [, text] = grammy.sendMessage.mock.calls[0];
    expect(text).toContain('Кира');
    expect(text).toContain('/assistants');
    expect(text).not.toContain('Подключить Telegram');
  });

  it('непривязанному даётся кнопка мини-аппа, а не совет идти в веб', async () => {
    // Совет «зайди в кабинет» был тупиком: войти в веб можно только по
    // телефону или почте, то есть человеку БЕЗ аккаунта предлагали то, чего
    // он сделать не может. Мини-апп — единственная дверь для регистрации
    // прямо из Telegram.
    identity.getLinkeonIdByTgUserId.mockResolvedValue(null);

    await (svc as any).handleMessage(msg('привет'));

    const [, text, opts] = grammy.sendMessage.mock.calls[0];
    expect(text).not.toContain('кабинет');
    const button = opts.reply_markup.inline_keyboard[0][0];
    expect(button.web_app.url).toContain('/tma/');
  });

  it('/start у непривязанного — та же кнопка', async () => {
    identity.getLinkeonIdByTgUserId.mockResolvedValue(null);

    await (svc as any).handleMessage(msg('/start'));

    const [, , opts] = grammy.sendMessage.mock.calls[0];
    expect(opts.reply_markup.inline_keyboard[0][0].web_app.url).toContain('/tma/');
  });
});
