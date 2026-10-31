// src/guest-trial/guest-origin.ts

/**
 * Проверка Origin открытых ручек пробы (config, chat, session — без JWT).
 *
 * main.ts включает CORS для ЛЮБОГО источника (enableCors({ origin: '*' }))
 * ради остальных публичных ручек, но кабинет зовёт /webhook/guest/* только со
 * своего адреса — у чужих сайтов нет причины дёргать эти ручки из браузеров
 * своих посетителей и тратить общие окна проб (ревью A7).
 */
const ALLOWED_GUEST_ORIGINS: readonly string[] = ['https://my.linkeon.io', 'https://test.linkeon.io'];

/** Dev-сервер (Vite и т.п.): http на localhost/127.0.0.1, порт любой. */
const LOCAL_GUEST_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

/**
 * Без заголовка Origin — разрешено: его шлют только браузеры при межсайтовых
 * запросах, значит это не браузер (curl, сервер, мобильное приложение без
 * WebView). С заголовком — только свои адреса, точным совпадением: обычные
 * startsWith/includes пропустили бы https://my.linkeon.io.evil.com как «свой».
 */
export function isAllowedGuestOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  return ALLOWED_GUEST_ORIGINS.includes(origin) || LOCAL_GUEST_ORIGIN_RE.test(origin);
}
