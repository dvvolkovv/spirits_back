import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDemoPhone } from './guard';

test('номер тестового шаблона принимается', () => {
  assert.equal(assertDemoPhone(' 79030000001 '), '79030000001');
});

test('живой номер отклоняется', () => {
  assert.throws(() => assertDemoPhone('79161234567'), /790300XXXXX/);
});

test('пустой и короткий номер отклоняются', () => {
  assert.throws(() => assertDemoPhone(''), /790300XXXXX/);
  assert.throws(() => assertDemoPhone('7903000001'), /790300XXXXX/);
});
