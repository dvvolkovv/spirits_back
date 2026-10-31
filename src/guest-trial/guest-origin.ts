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
 * Без заголовка Origin — разрешено. Но это НЕ признак «не браузер» (ревью
 * A10, прежняя версия этого комментария была неверной): браузер не добавляет
 * Origin и на простом same-origin GET/HEAD — а это ровно наш случай, когда
 * кабинет сам с my.linkeon.io зовёт свой guest/config. Отличает браузер от
 * curl/сервера не ЭТО, а то, что на POST и на любом межсайтовом (CORS) запросе
 * браузер Origin шлёт ВСЕГДА — и тогда либо чужой адрес, либо буквальная
 * строка 'null' (опак-origin: sandboxed iframe, file://, редирект). Отсюда
 * политика: нет заголовка — пропускаем (это и свой же сайт, и не-браузер);
 * есть — сверяем со своими адресами точным совпадением (обычные
 * startsWith/includes пропустили бы https://my.linkeon.io.evil.com как
 * «свой»). 'null' и '' — не наш адрес, запрещены явно, а не случайным
 * совпадением с общей проверкой ниже.
 */
export function isAllowedGuestOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === '' || origin === 'null') return false;
  return ALLOWED_GUEST_ORIGINS.includes(origin) || LOCAL_GUEST_ORIGIN_RE.test(origin);
}
