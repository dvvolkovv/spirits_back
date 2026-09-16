import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoomPageOrigin, zoomPageUrl } from '../src/zoom-page.mjs';

/**
 * Своя страница для Meeting SDK.
 *
 * Проверяем то, из-за чего страница молча не работает: заголовки изоляции
 * источника (без них SDK не получает SharedArrayBuffer и падает на старте) и
 * то, что версия SDK в разметке запинена, а не взята «последняя».
 */

test('страница отдаётся с изоляцией источника и запиненным SDK', async () => {
  const base = await zoomPageOrigin();
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');

  const html = await res.text();
  assert.match(html, /source\.zoom\.us\/5\.1\.4\/zoom-meeting-5\.1\.4\.min\.js/, 'версия SDK запинена');
  assert.match(html, /<script src="page\.js">/);
});

test('сценарий страницы отдаётся и умеет входить, писать и выходить', async () => {
  const base = await zoomPageOrigin();
  const js = await (await fetch(base + '/page.js')).text();
  assert.match(js, /ZoomMtg\.join/);
  assert.match(js, /__botSendChat/);
  assert.match(js, /__botLeave/);
});

test('чего не просили — не отдаём', async () => {
  const base = await zoomPageOrigin();
  assert.equal((await fetch(base + '/../.env')).status, 404);
});

test('параметры входа уезжают в адрес', async () => {
  const url = zoomPageUrl('http://x', {
    signature: 'подпись', sdkKey: 'ключ', meetingNumber: '76639252685', password: 'п', userName: 'Роман (ассистент)',
  });
  const q = new URL(url).searchParams;
  assert.equal(q.get('meetingNumber'), '76639252685');
  assert.equal(q.get('userName'), 'Роман (ассистент)');
  assert.equal(q.get('signature'), 'подпись');
});
