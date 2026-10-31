import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_THRESHOLD, speechCheck, speechWords } from './match';
import { ACCEPTED, FALSE_REJECTS, TRUE_REJECTS } from './match-corpus';

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

test('проглоченное последнее предложение реплики ловится — обрыв в конце клипа', () => {
  const r = speechCheck(['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'], 'обои потерли залог мой спокойно');
  assert.deepEqual(r.silentLines, [1]);
  assert.equal(r.ok, false);
});

test('междометия через дефис и без гласных не дают ложного отказа', () => {
  assert.equal(speechCheck(['А-а-а! Обои!', 'Спокойно.'], 'ааа обои спокойно').ok, true);
  assert.deepEqual(speechCheck(['Ш-ш-ш! Залог мой!'], 'залог мой'), { ok: true, share: 1, silentLines: [] });
});

test('междометие или крик последним предложением не дают ложного отказа, если SpeechKit их не записал', () => {
  for (const line of ['Залог мой! Ага!', 'Обои потёрли! Ааа!', 'Залог мой! Ого!', 'Залог мой! Кря!', 'Залог мой! Гав-гав!']) {
    const r = speechCheck([line], line.split('!')[0]);
    assert.equal(r.ok, true, `${line}: ${JSON.stringify(r)}`);
  }
  // Настоящее последнее предложение по-прежнему ловится.
  assert.deepEqual(speechCheck(['Спокойно. Спрошу у юриста.'], 'спокойно').silentLines, [0]);
});

test('повтор слога через тире или неразрывный дефис склеивается, как через дефис', () => {
  for (const dash of ['-', String.fromCharCode(0x2011), String.fromCharCode(0x2013)]) {
    const r = speechCheck([`Ой${dash}ой${dash}ой! Залог мой!`], 'залог мой');
    assert.equal(r.ok, true, `${JSON.stringify(dash)}: ${JSON.stringify(r)}`);
  }
});

test('знак ударения не делит слово', () => {
  assert.deepEqual(speechWords('за' + String.fromCharCode(0x301) + 'лог'), ['залог']);
});

test('корпус: клипы, принятые на проде и стенде, остаются принятыми', () => {
  const bad = ACCEPTED.map((c) => ({ name: c.name, ...speechCheck(c.lines, c.heard) })).filter((r) => !r.ok);
  assert.deepEqual(bad, []);
});

test('корпус: годные клипы, которые прежняя сверка отвергла, — приняты', () => {
  const bad = FALSE_REJECTS.map((c) => ({ name: c.name, ...speechCheck(c.lines, c.heard) })).filter((r) => !r.ok);
  assert.deepEqual(bad, []);
});

test('корпус: настоящий брак отвергнут, непрозвучавшие реплики названы', () => {
  const got = TRUE_REJECTS.map((c) => {
    const { ok, silentLines } = speechCheck(c.lines, c.heard);
    return { name: c.name, ok, silentLines };
  });
  assert.deepEqual(got, TRUE_REJECTS.map((c) => ({ name: c.name, ok: false, silentLines: c.silent })));
});
