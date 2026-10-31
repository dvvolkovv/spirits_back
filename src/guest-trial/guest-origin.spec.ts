// src/guest-trial/guest-origin.spec.ts
import { isAllowedGuestOrigin } from './guest-origin';

describe('isAllowedGuestOrigin', () => {
  it('без заголовка Origin — разрешено (запрос не из браузера)', () => {
    expect(isAllowedGuestOrigin(undefined)).toBe(true);
  });

  it('свои адреса — разрешены', () => {
    expect(isAllowedGuestOrigin('https://my.linkeon.io')).toBe(true);
    expect(isAllowedGuestOrigin('https://test.linkeon.io')).toBe(true);
  });

  it('локальная разработка — localhost и 127.0.0.1, порт любой', () => {
    expect(isAllowedGuestOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedGuestOrigin('http://127.0.0.1:4173')).toBe(true);
  });

  it('чужой сайт — запрещён', () => {
    expect(isAllowedGuestOrigin('https://evil.com')).toBe(false);
  });

  it('похожий домен с чужим хвостом — запрещён (не startsWith/includes)', () => {
    expect(isAllowedGuestOrigin('https://my.linkeon.io.evil.com')).toBe(false);
  });

  it('свой домен, но без https — запрещён', () => {
    expect(isAllowedGuestOrigin('http://my.linkeon.io')).toBe(false);
  });
});
