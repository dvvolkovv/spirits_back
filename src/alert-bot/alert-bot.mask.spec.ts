import { maskForModel, maskText, toolText, userLabel } from './alert-bot.mask';

describe('маска бота алертов', () => {
  beforeEach(() => { process.env.RELAY_FS_SALT = 'spec-salt'; });

  it('маскирует телефон, почту, UUID и секреты, но не имя', () => {
    const ticket = '11111111-1111-4111-8111-111111111111';
    const out = maskText(
      `Ирина +7 (901) 234-56-78, a@example.com, ${ticket}, ` +
      `22222222-2222-4222-8222-222222222222, Bearer abc.def.ghi, ` +
      `123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg, ` +
      `https://x.test/?token=SECRET-ИЗ-ОТВЕТА`,
      [ticket],
    );
    expect(out).toContain('Ирина');
    expect(out).toContain('+7 *** *** 78');
    expect(out).toContain('a***@example.com');
    expect(out).toContain('#11111111');
    expect(out).toContain('[id]');
    expect(out).toContain('Bearer [скрыто]');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('SECRET-ИЗ-ОТВЕТА');
    expect(out).not.toContain('123456789:');
  });

  it('не принимает короткое число за телефон', () => {
    expect(maskText('оплат 42, ошибок 123456')).toBe('оплат 42, ошибок 123456');
  });

  it('рекурсивно маскирует структуру', () => {
    expect(maskForModel({ user: { email: 'b@example.com' }, items: ['+79012345678'] })).toEqual({
      user: { email: 'b***@example.com' }, items: ['+7 *** *** 78'],
    });
  });

  it('метка пользователя стабильна и не содержит id', () => {
    expect(userLabel('u-admin', 'Дмитрий')).toEqual({ user: userLabel('u-admin').user, name: 'Дмитрий' });
    expect(JSON.stringify(userLabel('u-admin'))).not.toContain('u-admin');
    expect(userLabel('u-admin').user).toMatch(/^u:[0-9a-f]{6}$/);
  });

  it('без соли не выдаёт идентификатор', () => {
    delete process.env.RELAY_FS_SALT;
    expect(() => userLabel('u-admin')).toThrow('RELAY_FS_SALT required');
  });

  it('выход инструмента не превышает 8 КБ', () => {
    const out = toolText({ text: 'я'.repeat(20_000) });
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(8192);
    expect(out).toContain('[обрезано]');
  });

  it('маскирует ключи и не теряет записи при коллизии масок', () => {
    expect(maskForModel({ '+79012345678': 'первый', '+79912345678': 'второй' })).toEqual({
      '+7 *** *** 78': 'первый',
      '+7 *** *** 78#2': 'второй',
    });
    expect(toolText({ '+79012345678': 'ok' })).toBe('{"+7 *** *** 78":"ok"}');
  });

  it('не даёт собственному или унаследованному toJSON обойти маску', () => {
    const own = {
      note: 'ok',
      toJSON: () => '+79012345678',
      callback: () => 'не показывать',
    };
    expect(toolText(own)).toBe('{"note":"ok"}');

    const inherited = Object.create({ toJSON: () => '+79012345678' }) as { note: string };
    inherited.note = 'ok';
    expect(toolText(inherited)).toBe('{"note":"ok"}');
  });

  it('маскирует финальный JSON независимо от сериализации', () => {
    const stringify = jest.spyOn(JSON, 'stringify').mockReturnValue('"+79012345678"');
    try {
      expect(toolText({})).toBe('"+7 *** *** 78"');
    } finally {
      stringify.mockRestore();
    }
  });

  it('сохраняет числа только под temporal keys и не ломает JSON при финальной маске', () => {
    const timestamps = {
      at: 1_800_000_000,
      ts: 1_800_000_001,
      time: 1_800_000_002,
      timestamp: 1_800_000_003,
      date: 1_800_000_004,
      from: 1_800_000_005,
      to: 1_800_000_006,
      since: 1_800_000_007,
      until: 1_800_000_008,
      created_at: 1_800_000_009,
      createdAt: 1_800_000_010,
      updated_at: 120_000_000_000,
      updatedAt: 120_000_000_001,
      latest_ts: 120_000_000_002,
      latestTs: 120_000_000_003,
      expires_at: 120_000_000_004,
      expiresAt: 120_000_000_005,
      due_at: 120_000_000_006,
      dueAt: 120_000_000_007,
    };
    const out = toolText({ metric: timestamps });
    expect(JSON.parse(out)).toEqual({ metric: timestamps });
  });

  it.each([1_800_000_000, 120_000_000_000])(
    'маскирует %i под phone и обычным ключом, несмотря на Unix-диапазон',
    (value) => {
      const out = toolText({ phone: value, duration: value });
      const parsed = JSON.parse(out);
      expect(parsed.phone).toBe(maskText(String(value)));
      expect(parsed.duration).toBe(maskText(String(value)));
      expect(typeof parsed.phone).toBe('string');
      expect(typeof parsed.duration).toBe('string');
      expect(out).not.toContain(String(value));
    },
  );

  it('не раскрывает phone из Unix-диапазона в аварийном JSON-wrapper', () => {
    jest.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw new SyntaxError('forced'); });
    const out = toolText({ phone: 1_800_000_000 });
    expect(out).not.toContain('1800000000');
    expect(out).toContain(maskText('1800000000'));
    expect(JSON.parse(out)).toEqual(expect.any(Object));
  });

  it('маскирует числовой телефон, сохраняя Unix timestamps числами и валидный JSON', () => {
    const out = toolText({ at: 1_800_000_000, phone: 7_901_234_5678 });
    const parsed = JSON.parse(out);
    expect(parsed.at).toBe(1_800_000_000);
    expect(typeof parsed.at).toBe('number');
    expect(parsed.phone).toBe('+7 *** *** 78');
    expect(out).not.toContain('79012345678');
  });

  it('при сбое финальной JSON-проверки отдаёт безопасный wrapper, а не исходный JSON', () => {
    jest.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw new SyntaxError('forced'); });
    const out = toolText({ phone: 7_901_234_5678 });
    expect(out).not.toContain('79012345678');
    expect(out).toContain('+7 *** *** 78');
    expect(JSON.parse(out)).toEqual(expect.any(Object));
  });

  it('маскирует UUID рядом с underscore и сохраняет ticket #prefix', () => {
    const ticket = '018f2c3a-9d4e-7abc-8def-abcdef123456';
    expect(maskText(`user_${ticket}`)).toBe('user_[id]');
    expect(maskText(`${ticket}_psychologist`)).toBe('[id]_psychologist');
    expect(maskText(`user_${ticket} ${ticket}_psychologist`, [ticket])).toBe(
      'user_#018f2c3a #018f2c3a_psychologist',
    );
  });

  it('маскирует UUID без ограничения версии и варианта', () => {
    const ticket = '018f2c3a-9d4e-7abc-8def-abcdef123456';
    expect(maskText(ticket)).toBe('[id]');
    expect(maskText(ticket, [ticket])).toBe('#018f2c3a');
    expect(maskText('00000000-0000-0000-0000-000000000000')).toBe('[id]');
  });

  it('маскирует секреты, оканчивающиеся дефисом', () => {
    expect(maskText(`123456789:${'A'.repeat(29)}-`)).toBe('[скрыто]');
    expect(maskText(`sk-${'A'.repeat(11)}-`)).toBe('[скрыто]');
  });

  it('маскирует JWT с дефисом на конце, в том числе после Bearer', () => {
    const jwt = `eyJ${'A'.repeat(8)}.${'B'.repeat(8)}.${'C'.repeat(7)}-`;
    expect(maskText(jwt)).toBe('[скрыто]');
    expect(maskText(`Bearer ${jwt}`)).toBe('Bearer [скрыто]');
  });
});
