import { TgCommandsService } from './tg-commands.service';

/**
 * Язык раньше нельзя было сменить из бота вовсе — только в вебе или мини-аппе.
 * Пишем в то же поле profile_data.language, что и они: один источник правды,
 * как и с текущим ассистентом.
 */
describe('/language', () => {
  const grammy = { sendMessage: jest.fn(), answerCallbackQuery: jest.fn() };
  const pg = { query: jest.fn() };
  const svc = new TgCommandsService(
    pg as any, grammy as any, {} as any, {} as any, {} as any, {} as any,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    pg.query.mockResolvedValue({ rows: [{ language: 'ru' }] });
  });

  it('показывает семь языков сайта родными названиями', async () => {
    pg.query.mockResolvedValue({ rows: [{ language: null }] }); // без текущего — без галочки
    await svc.handleLanguage({ chat: { id: 777 }, from: { id: 42 } } as any, 'u-1');

    const [, , opts] = grammy.sendMessage.mock.calls[0];
    const buttons = opts.reply_markup.inline_keyboard.flat();
    expect(buttons).toHaveLength(7);
    expect(buttons.map((b: any) => b.text)).toEqual(
      expect.arrayContaining(['Русский', 'English', 'Español', 'Deutsch', 'Français', '中文', 'Português']),
    );
  });

  it('текущий язык помечен галочкой', async () => {
    await svc.handleLanguage({ chat: { id: 777 }, from: { id: 42 } } as any, 'u-1');

    const buttons = grammy.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard.flat();
    const marked = buttons.filter((b: any) => b.text.startsWith('✓'));
    expect(marked).toHaveLength(1);
    expect(marked[0].text).toBe('✓ Русский');
  });

  it('выбор пишет profile_data.language и подтверждает', async () => {
    await svc.handleLanguageCallback(
      { id: 'cb-1', data: 'lang:es', message: { chat: { id: 777 } }, from: { id: 42 } } as any,
      'u-1',
    );

    const update = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('UPDATE ai_profiles_consolidated'));
    expect(update).toBeDefined();
    expect(update[1]).toEqual(expect.arrayContaining([expect.stringContaining('es')]));
    expect(grammy.sendMessage).toHaveBeenCalledWith(777, expect.stringContaining('Español'), expect.anything());
  });

  it('неизвестный код не пишется в профиль', async () => {
    await svc.handleLanguageCallback(
      { id: 'cb-2', data: 'lang:kk', message: { chat: { id: 777 } }, from: { id: 42 } } as any,
      'u-1',
    );

    const update = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('UPDATE ai_profiles_consolidated'));
    expect(update).toBeUndefined();
  });
});
