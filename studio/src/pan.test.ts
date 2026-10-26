import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panOffset } from './pan';

const base = { imageHeight: 9000, frameHeight: 1920, anchorY: 760 };

test('середина абзаца встаёт на линию', () => {
  assert.equal(panOffset({ ...base, boxTop: 3000, boxHeight: 200 }), -2340);
});

test('у верха картинки сдвига нет — над ней не видно пустоты', () => {
  assert.equal(panOffset({ ...base, boxTop: 100, boxHeight: 200 }), 0);
});

test('у низа картинка не уезжает выше кадра', () => {
  assert.equal(panOffset({ ...base, boxTop: 8800, boxHeight: 150 }), -7080);
});

test('картинка ниже кадра не двигается', () => {
  assert.equal(panOffset({ boxTop: 900, boxHeight: 200, imageHeight: 1500, frameHeight: 1920, anchorY: 760 }), 0);
});
