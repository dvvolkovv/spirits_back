import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformFor } from '../src/platform-url.mjs';

/**
 * Разбор адреса встречи.
 *
 * Ошибка здесь видна не сразу: бот молча уходит не на ту площадку или отвечает
 * отказом по живой ссылке. Поэтому проверяем не только «наши» адреса, но и
 * похожие чужие — ровно те, на которых легко ошибиться.
 */

test('наши площадки узнаются', () => {
  assert.equal(platformFor('https://telemost.yandex.ru/j/60786470391331'), 'telemost');
  assert.equal(platformFor('https://us04web.zoom.us/j/75281580798?pwd=abc.1'), 'zoom');
  assert.equal(platformFor('https://meet.google.com/ypj-ixta-fjs'), 'meet');
});

test('похожие чужие хосты не проходят', () => {
  assert.equal(platformFor('https://notzoom.us/j/123456789'), null);
  assert.equal(platformFor('https://notmeet.google.com/ypj-ixta-fjs'), null);
  assert.equal(platformFor('https://telemost.yandex.ru.evil.com/j/123456'), null);
});

test('ссылки без встречи не проходят', () => {
  assert.equal(platformFor('https://zoom.us/my/roman'), null, 'личная ссылка — номера встречи нет');
  assert.equal(platformFor('https://meet.google.com/new'), null, 'новая встреча — кода ещё нет');
  assert.equal(platformFor('созвонимся завтра в три'), null);
  assert.equal(platformFor(''), null);
  assert.equal(platformFor(undefined), null);
});

test('код Meet узнаётся в тексте и с параметрами', () => {
  assert.equal(platformFor('Заходи: https://meet.google.com/abc-defg-hij?authuser=0'), 'meet');
});
