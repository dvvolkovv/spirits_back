import { SETTINGS_DEFAULTS, ShortsSettingsService, validateSettingsPatch } from './shorts-settings.service';

describe('ShortsSettingsService', () => {
  it('нет строки — значения по умолчанию', async () => {
    const svc = new ShortsSettingsService({ query: jest.fn(async () => ({ rows: [] })) } as any);
    expect(await svc.get()).toEqual(SETTINGS_DEFAULTS);
  });

  it('строка базы — числами и списками', async () => {
    const row = {
      slot_days: ['2', '4'], slot_hour_msk: '19', prepare_lead_hours: 12, min_answer_chars: 500,
      tg_channel_chat_id: '-1003290853538', platforms: ['telegram'], narrator_voice: 'jane',
      format: 'chat', max_omni_seconds: '96',
    };
    const svc = new ShortsSettingsService({ query: jest.fn(async () => ({ rows: [row] })) } as any);
    expect(await svc.get()).toEqual({
      slotDays: [2, 4], slotHourMsk: 19, prepareLeadHours: 12, minAnswerChars: 500,
      tgChannelChatId: '-1003290853538', platforms: ['telegram'], narratorVoice: 'jane',
      format: 'chat', maxOmniSeconds: 96,
    });
  });

  it('правка пишет только переданные поля', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    await new ShortsSettingsService({ query } as any).update({ slotHourMsk: 20, platforms: ['telegram'] });
    const [sql, args] = query.mock.calls[0] as any[];
    expect(sql).toBe('UPDATE short_settings SET slot_hour_msk = $1, platforms = $2, updated_at = now() WHERE id = 1');
    expect(args).toEqual([20, ['telegram']]);
  });
});

describe('validateSettingsPatch', () => {
  it('дни сортируются, корректное проходит', () => {
    expect(validateSettingsPatch({ slotDays: [6, 2, 4], slotHourMsk: 18, tgChannelChatId: '-1003290853538' }))
      .toEqual({ slotDays: [2, 4, 6], slotHourMsk: 18, tgChannelChatId: '-1003290853538' });
    expect(validateSettingsPatch({ tgChannelChatId: null })).toEqual({ tgChannelChatId: null });
    expect(validateSettingsPatch({ format: 'chat', maxOmniSeconds: 96 })).toEqual({ format: 'chat', maxOmniSeconds: 96 });
  });

  it('по умолчанию — сценки и 48 с Omni на ролик', () => {
    expect([SETTINGS_DEFAULTS.format, SETTINGS_DEFAULTS.maxOmniSeconds]).toEqual(['skit', 48]);
  });

  it.each([
    [{ slotDays: [] }, /slotDays/],
    [{ slotDays: [8] }, /slotDays/],
    [{ slotDays: [2, 2] }, /slotDays/],
    [{ slotHourMsk: 24 }, /slotHourMsk/],
    [{ prepareLeadHours: 0 }, /prepareLeadHours/],
    [{ minAnswerChars: 50 }, /minAnswerChars/],
    [{ tgChannelChatId: '@linkeontest' }, /tgChannelChatId/],
    [{ platforms: ['vk'] }, /VK/],
    [{ platforms: [] }, /platforms/],
    [{ narratorVoice: 'nova' }, /narratorVoice/],
    [{ format: 'cartoon' }, /format/],
    [{ maxOmniSeconds: 4 }, /maxOmniSeconds/],
    [{ maxOmniSeconds: 48.5 }, /maxOmniSeconds/],
    [{ maxOmniSeconds: '48' }, /maxOmniSeconds/],
    [{ colour: 'red' }, /неизвестная настройка: colour/],
  ])('%j — ошибка', (body, message) => {
    expect(() => validateSettingsPatch(body)).toThrow(message);
  });
});
