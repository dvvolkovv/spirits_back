import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signZoomJoin, parseZoomUrl } from '../src/zoom-jwt.mjs';

/**
 * Подпись входа и разбор ссылки.
 *
 * Ошибиться здесь легко и незаметно: неверная подпись выглядит на встрече как
 * «бот не пришёл», без внятной причины в логе, а лишний параметр в ссылке
 * уводит SDK в чужую встречу. Проверяем ровно то, что смотрит Zoom.
 */

const decode = (part) => JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

test('подпись несёт поля, которых требует Zoom', () => {
  const { signature, sdkKey } = signZoomJoin({
    clientId: 'КЛЮЧ',
    clientSecret: 'секрет',
    meetingNumber: '76639252685',
    now: 1_700_000_000,
  });
  const [head, body, sig] = signature.split('.');
  assert.deepEqual(decode(head), { alg: 'HS256', typ: 'JWT' });

  const claims = decode(body);
  assert.equal(claims.appKey, 'КЛЮЧ');
  assert.equal(claims.sdkKey, 'КЛЮЧ');
  assert.equal(claims.mn, '76639252685', 'номер встречи строкой');
  assert.equal(claims.role, 0, 'бот всегда участник, не хозяин');
  assert.equal(claims.iat, 1_700_000_000);
  assert.equal(claims.exp, claims.tokenExp, 'tokenExp обязателен и равен exp');
  assert.ok(claims.exp - claims.iat >= 1800, 'Zoom не принимает срок короче получаса');

  assert.equal(sdkKey, 'КЛЮЧ');
  const expected = createHmac('sha256', 'секрет').update(`${head}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(sig, expected, 'подпись — HMAC над header.payload');
});

test('без ключей подпись не делается', () => {
  assert.throws(() => signZoomJoin({ meetingNumber: '1' }), /ZOOM_SDK_CLIENT_ID/);
});

test('из ссылки берём номер встречи и хеш пароля', () => {
  assert.deepEqual(
    parseZoomUrl('https://us04web.zoom.us/j/76639252685?pwd=aGFzaA'),
    { meetingNumber: '76639252685', password: 'aGFzaA' },
  );
});

test('вебинар и ссылка без пароля тоже разбираются', () => {
  assert.deepEqual(parseZoomUrl('https://zoom.us/w/987654321'), { meetingNumber: '987654321', password: '' });
});

test('чужой хост и личная ссылка — не Zoom', () => {
  // `notzoom.us` прошёл бы без точки в регулярке, а в личной ссылке номера
  // встречи нет вовсе: SDK по ней войти не может, и лучше честный отказ.
  assert.equal(parseZoomUrl('https://notzoom.us/j/123456789'), null);
  assert.equal(parseZoomUrl('https://zoom.us/my/roman'), null);
});
