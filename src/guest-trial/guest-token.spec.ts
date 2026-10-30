import { hashClaimer, hashGuestToken, isGuestTokenShape, newGuestToken } from './guest-token';

describe('ключ пробы', () => {
  it('43 знака base64url и разный каждый раз', () => {
    const a = newGuestToken();
    const b = newGuestToken();
    expect(isGuestTokenShape(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('форма проверяется строго', () => {
    expect(isGuestTokenShape('x'.repeat(42))).toBe(false);
    expect(isGuestTokenShape('x'.repeat(43))).toBe(true);
    expect(isGuestTokenShape(`${'x'.repeat(42)}/`)).toBe(false);
    expect(isGuestTokenShape(undefined)).toBe(false);
  });

  it('в базу — хеш: детерминированный и без самого ключа', () => {
    const t = newGuestToken();
    expect(hashGuestToken(t)).toBe(hashGuestToken(t));
    expect(hashGuestToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGuestToken(t)).not.toContain(t);
  });

  it('хеш переносящего — без userId и не совпадает с хешем того же текста как ключа', () => {
    expect(hashClaimer('user-42')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClaimer('user-42')).not.toBe(hashGuestToken('user-42'));
  });
});
