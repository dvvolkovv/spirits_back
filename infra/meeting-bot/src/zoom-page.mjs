import http from 'node:http';
import { ZOOM_PAGE_HTML, ZOOM_PAGE_JS } from './payload/zoom.mjs';

/**
 * Свой сайт для страницы Zoom.
 *
 * Meeting SDK живёт не на чужой странице, а на нашей, и её надо откуда-то
 * отдать. Отдельный сервер, а не наш API, по двум причинам: API требует ключ в
 * заголовке на каждый запрос (браузер его не пришлёт), и странице нужны
 * заголовки COOP/COEP, которых остальному API не надо.
 *
 * Слушаем только 127.0.0.1: наружу отдавать нечего, страница нужна одному
 * браузеру на этой же машине.
 */

let server = null;
let origin = '';

/** Поднять сервер (один на процесс) и вернуть его адрес. */
export function zoomPageOrigin() {
  if (origin) return Promise.resolve(origin);
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const path = (req.url || '').split('?')[0];
      const [body, type] = path === '/page.js'
        ? [ZOOM_PAGE_JS, 'application/javascript; charset=utf-8']
        : path === '/' || path === '/index.html'
          ? [ZOOM_PAGE_HTML, 'text/html; charset=utf-8']
          : [null, null];
      if (!body) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': type,
        // Без изоляции источника SDK не получает SharedArrayBuffer и падает
        // на старте — проверено Attendee, у которого те же два заголовка.
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      res.end(body);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // Держать процесс живым — не его дело: сервер существует ради браузера,
      // а браузер закрывается вместе с ботом.
      server.unref?.();
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve(origin);
    });
  });
}

/** Адрес страницы для конкретного входа. */
export function zoomPageUrl(base, { signature, sdkKey, meetingNumber, password, userName, obfToken }) {
  const p = new URLSearchParams({
    signature,
    sdkKey,
    meetingNumber,
    password: password || '',
    userName,
    // Токен On-Behalf-Of, если бэкенд его добыл. Пустой — значит идём во
    // встречу своего аккаунта, как до правил Zoom от 2 марта 2026.
    obfToken: obfToken || '',
  });
  return `${base}/?${p.toString()}`;
}
