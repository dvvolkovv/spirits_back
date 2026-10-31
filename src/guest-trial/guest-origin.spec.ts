// src/guest-trial/guest-origin.spec.ts
import { isAllowedGuestOrigin } from './guest-origin';

describe('isAllowedGuestOrigin', () => {
  // Ревью A10: браузер НЕ шлёт Origin и на простом same-origin GET/HEAD —
  // значит отсутствие заголовка само по себе не означает «не браузер», это
  // в т.ч. свой же кабинет, открывающий guest/config с my.linkeon.io.
  it('без заголовка Origin — разрешено (в т.ч. свой same-origin GET, не только curl/сервер)', () => {
    expect(isAllowedGuestOrigin(undefined)).toBe(true);
  });

  it('свои адреса — разрешены', () => {
    expect(isAllowedGuestOrigin('https://my.linkeon.io')).toBe(true);
    expect(isAllowedGuestOrigin('https://test.linkeon.io')).toBe(true);
  });

  it('origin "null" (опак — sandboxed iframe, file://, редирект) — запрещён', () => {
    expect(isAllowedGuestOrigin('null')).toBe(false);
  });

  it('пустая строка — запрещена', () => {
    expect(isAllowedGuestOrigin('')).toBe(false);
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
