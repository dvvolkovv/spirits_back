import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHORT_LIMITS } from './ffprobe';
import { CAPTURE_SCALE, CAPTURE_VIEWPORT, FRAME } from './frame';

test('окно съёмки при плотности даёт ровно кадр ролика', () => {
  assert.ok(Number.isInteger(CAPTURE_VIEWPORT.width) && Number.isInteger(CAPTURE_VIEWPORT.height));
  assert.equal(CAPTURE_VIEWPORT.width * CAPTURE_SCALE, FRAME.width);
  assert.equal(CAPTURE_VIEWPORT.height * CAPTURE_SCALE, FRAME.height);
});

test('проверка готового файла ждёт тот же кадр', () => {
  assert.deepEqual([SHORT_LIMITS.width, SHORT_LIMITS.height], [FRAME.width, FRAME.height]);
});
