import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_THRESHOLD, speechMatch, speechWords } from './match';

test('слова — без регистра, знаков и с «е» вместо «ё»', () => {
  assert.deepEqual(speechWords('Обои потёрли! Залог — мой.'), ['обои', 'потерли', 'залог', 'мой']);
  assert.deepEqual(speechWords('Га-га… ладно.'), ['га', 'га', 'ладно']);
});

test('всё сказано — 1, ничего не услышано — 0', () => {
  const lines = ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'];
  assert.equal(speechMatch(lines, 'обои потерли залог мой спокойно спрошу у юриста'), 1);
  assert.equal(speechMatch(lines, ''), 0);
});

test('часть реплик проглочена — доля услышанных слов', () => {
  assert.equal(speechMatch(['раз два три четыре'], 'раз два'), 0.5);
});

test('повтор слова считается столько раз, сколько сказан', () => {
  assert.equal(speechMatch(['га га ладно'], 'га ладно'), 2 / 3);
});

test('реплик нет — сверять нечего', () => {
  assert.equal(speechMatch([], 'что угодно'), 1);
});

test('стартовый порог — 0,6', () => {
  assert.equal(MATCH_THRESHOLD, 0.6);
});
