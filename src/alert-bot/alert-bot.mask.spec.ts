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
});
