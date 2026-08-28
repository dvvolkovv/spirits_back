import { TgCommandsService } from './tg-commands.service';

describe('/assistants', () => {
  const grammy = { sendMessage: jest.fn(), answerCallbackQuery: jest.fn() };
  const agents = { getAgents: jest.fn(), changeAgent: jest.fn() };
  const pg = { query: jest.fn() };
  const configs = { getActiveByTgChatId: jest.fn() };

  const svc = new TgCommandsService(
    pg as any,
    grammy as any,
    {} as any, // billing
    {} as any, // identity
    agents as any,
    configs as any,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    agents.getAgents.mockResolvedValue([{ id: 1, name: 'Миша' }, { id: 2, name: 'Оля' }]);
    pg.query.mockResolvedValue({ rows: [{ preferred_agent: 'Оля' }] });
    configs.getActiveByTgChatId.mockResolvedValue({ id: 'cfg-1' });
  });

  it('показывает список с пометкой текущего', async () => {
    await svc.handleAssistants({ chat: { id: 777 }, from: { id: 42 } } as any, 'u-1');

    const [, text, opts] = grammy.sendMessage.mock.calls[0];
    expect(text).toContain('Оля');
    const marked = opts.reply_markup.inline_keyboard.flat().find((b: any) => b.text.startsWith('✓'));
    expect(marked.text).toBe('✓ Оля');
  });

  it('нажатие переключает ассистента и подтверждает', async () => {
    await svc.handleAgentCallback(
      { id: 'cb-1', data: 'agent:Миша', message: { chat: { id: 777 }, message_id: 5 }, from: { id: 42 } } as any,
      'u-1',
    );

    expect(agents.changeAgent).toHaveBeenCalledWith('u-1', 'Миша');
    expect(grammy.sendMessage).toHaveBeenCalledWith(777, expect.stringContaining('Миша'), expect.anything());
  });

  it('неизвестное имя в callback не переключает', async () => {
    agents.getAgents.mockResolvedValue([{ id: 1, name: 'Миша' }]);

    await svc.handleAgentCallback(
      { id: 'cb-2', data: 'agent:Мишa-подделка', message: { chat: { id: 777 }, message_id: 5 }, from: { id: 42 } } as any,
      'u-1',
    );

    expect(agents.changeAgent).not.toHaveBeenCalled();
  });

  it('в историю пишется системная отметка о смене', async () => {
    await svc.handleAgentCallback(
      { id: 'cb-3', data: 'agent:Миша', message: { chat: { id: 777 }, message_id: 5 }, from: { id: 42 } } as any,
      'u-1',
    );

    const insert = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO tg_bot_messages'));
    expect(insert).toBeDefined();
    expect(insert[1]).toEqual(
      expect.arrayContaining([expect.stringContaining('Дальше отвечает Миша')]),
    );
  });
});
