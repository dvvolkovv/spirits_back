import { clockRedis } from '../auth/fake-redis.forspec';
import { GUEST_CARRY_MAX_CHARS, guestCarryKey, putGuestCarry, renderGuestCarry, takeGuestCarry } from './guest-carry';

describe('приписка о пробе', () => {
  it('кладётся на 7 дней и забирается один раз', async () => {
    const r = clockRedis();
    await putGuestCarry(r, 'u1', '12', 'текст');
    expect(await r.ttl(guestCarryKey('u1', '12'))).toBe(7 * 24 * 3600);
    expect(await takeGuestCarry(r, 'u1', '12')).toBe('текст');
    expect(await takeGuestCarry(r, 'u1', '12')).toBeNull();
  });

  it('пересказ: кто что сказал, без повторного приветствия', () => {
    const t = renderGuestCarry([
      { sender_type: 'human', content: 'Как поднять цены?' },
      { sender_type: 'ai', content: 'Начнём с сегментов.' },
    ]);
    expect(t).toContain('Человек: Как поднять цены?');
    expect(t).toContain('Ты: Начнём с сегментов.');
    expect(t).toContain('не здоровайся заново');
  });

  it('длинный разговор — хвост, а не начало', () => {
    const long = 'а'.repeat(GUEST_CARRY_MAX_CHARS);
    const t = renderGuestCarry([
      { sender_type: 'human', content: 'НАЧАЛО' },
      { sender_type: 'ai', content: long },
      { sender_type: 'human', content: 'КОНЕЦ' },
    ]);
    expect(t).not.toContain('НАЧАЛО');
    expect(t).toContain('КОНЕЦ');
  });
});
