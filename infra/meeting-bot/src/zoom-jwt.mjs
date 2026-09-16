import { createHmac } from 'node:crypto';

/**
 * Подпись входа для Zoom Meeting SDK.
 *
 * SDK пускает в встречу только с JWT, подписанным ключами приложения Zoom
 * Marketplace. Состав полей задан Zoom и проверяется на их стороне: лишнее
 * поле переживёт, а недостающее `tokenExp` — нет.
 *
 * Библиотеки ради этого не берём: JWT здесь — три базовых блока и один HMAC, и
 * зависимость обошлась бы дороже, чем эти двадцать строк.
 */

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Zoom требует срок жизни от получаса до двух суток. Держим два часа — как потолок встречи. */
const TTL_SEC = 2 * 60 * 60;

/**
 * @param {object} p
 * @param {string} p.clientId     ключ приложения (он же sdkKey)
 * @param {string} p.clientSecret секрет приложения
 * @param {string} p.meetingNumber номер встречи
 * @param {number} [p.role] 0 — участник, 1 — хозяин. Боту всегда 0.
 * @param {number} [p.now] текущее время в секундах — параметр ради тестов
 */
export function signZoomJoin({ clientId, clientSecret, meetingNumber, role = 0, now = Math.floor(Date.now() / 1000) }) {
  if (!clientId || !clientSecret) throw new Error('нет ключей Zoom: ZOOM_SDK_CLIENT_ID и ZOOM_SDK_CLIENT_SECRET');
  const exp = now + TTL_SEC;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    appKey: clientId,
    sdkKey: clientId,
    mn: String(meetingNumber),
    role,
    iat: now,
    exp,
    tokenExp: exp,
  }));
  const body = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', clientSecret).update(body).digest());
  return { signature: `${body}.${sig}`, sdkKey: clientId };
}

/**
 * Разобрать ссылку Zoom на номер встречи и пароль.
 *
 * `pwd` — это не пароль, а его хеш из ссылки; SDK принимает именно его. Личные
 * ссылки `/my/<имя>` не поддержаны сознательно: номера встречи в них нет.
 */
export function parseZoomUrl(url) {
  const m = /https?:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/(?:j|w)\/(\d{9,12})/i.exec(url || '');
  if (!m) return null;
  let password = '';
  try { password = new URL(url).searchParams.get('pwd') || ''; } catch { /* ссылка кривая — войдём без пароля */ }
  return { meetingNumber: m[1], password };
}
