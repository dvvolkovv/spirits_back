import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_THRESHOLD, speechCheck, speechWords } from './match';

test('слова — без регистра, знаков и с «е» вместо «ё»; дефис делит слово; NFD приводится к NFC', () => {
  assert.deepEqual(speechWords('Обои потёрли! Залог — мой.'), ['обои', 'потерли', 'залог', 'мой']);
  assert.deepEqual(speechWords('Га-га… ладно.'), ['га', 'га', 'ладно']);
  assert.deepEqual(speechWords('потёрли'.normalize('NFD')), ['потерли']);
});

test('всё сказано — годится; ничего не услышано — нет, обе реплики проглочены', () => {
  const lines = ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'];
  assert.deepEqual(speechCheck(lines, 'обои потерли залог мой спокойно спрошу у юриста'), { ok: true, share: 1, silentLines: [] });
  assert.deepEqual(speechCheck(lines, ''), { ok: false, share: 0, silentLines: [0, 1] });
});

test('числа цифрами и латиница не сверяются: SpeechKit пишет их по-своему', () => {
  assert.equal(speechCheck(['Залог 40 000 рублей.'], 'залог сорок тысяч рублей').share, 1);
  assert.equal(speechCheck(['Спрошу у Linkeon.'], 'спрошу у линкеон').share, 1);
});

test('слитное «гага» засчитывается за «га-га»', () => {
  assert.deepEqual(speechCheck(['Га-га… ладно.'], 'гага ладно'), { ok: true, share: 1, silentLines: [] });
  assert.equal(speechCheck(['Ай-ай-ай!'], 'айайай').share, 1);
});

test('проглоченная короткая реплика ловится, даже когда общая доля выше порога', () => {
  const r = speechCheck(['Обои потёрли! Залог мой, весь до копейки!', 'Спокойно. Спрошу у юриста.'], 'обои потерли залог мой весь до копейки');
  assert.ok(r.share >= MATCH_THRESHOLD);
  assert.deepEqual(r.silentLines, [1]);
  assert.equal(r.ok, false);
});

test('часть слов перевраны — доля услышанных; доля на пороге годится', () => {
  assert.deepEqual(speechCheck(['раз два три четыре пять'], 'раз два три'), { ok: true, share: 0.6, silentLines: [] });
  assert.equal(speechCheck(['раз два три четыре пять'], 'раз два').ok, false);
});

test('повтор слова считается столько раз, сколько сказан', () => {
  assert.equal(speechCheck(['да да ладно'], 'да ладно').share, 2 / 3);
});

test('реплик нет — сверять нечего', () => {
  assert.deepEqual(speechCheck([], 'что угодно'), { ok: true, share: 1, silentLines: [] });
});
