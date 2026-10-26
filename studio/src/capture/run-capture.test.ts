import { test } from 'node:test';
import assert from 'node:assert/strict';

test('команду capture можно импортировать: без аргументов она не запускается', async () => {
  const m = await import('./run-capture');
  assert.equal(typeof m.captureScene, 'function');
  assert.equal(m.DEFAULT_MIN_ANSWER_CHARS, 400);
});
