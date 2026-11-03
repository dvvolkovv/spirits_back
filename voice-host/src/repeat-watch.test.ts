import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RepeatWatch, repeatLine, REPEAT_MIN_CHARS } from './repeat-watch.js';

/** Реплика нужной длины — чтобы попадать выше порога, не считая знаки руками. */
const long = (seed = 'a') => `Реплика ассистента ${seed.repeat(REPEAT_MIN_CHARS)}`;

describe('RepeatWatch', () => {
  test('первая реплика повтором не считается', () => {
    const w = new RepeatWatch();
    assert.equal(w.note('assistant', long(), 'item_1', 1000), null);
  });

  test('дословный повтор другой записью — это второй ответ, и он назван так', () => {
    const w = new RepeatWatch();
    w.note('assistant', long(), 'item_1', 1000);
    const r = w.note('assistant', long(), 'item_2', 21000);
    assert.ok(r, 'повтор не замечен');
    assert.equal(r!.sameItem, false);
    assert.equal(r!.earlierId, 'item_1');
    assert.equal(r!.id, 'item_2');
    assert.equal(r!.sinceMs, 20000);
  });

  // Ровно та половина вопроса, которой не хватало: без неё лог молчит
  // одинаково и при двойной доставке, и при полном отсутствии повторов.
  test('та же запись, доехавшая дважды, отличается от второго ответа', () => {
    const w = new RepeatWatch();
    w.note('assistant', long(), 'item_1', 1000);
    const r = w.note('assistant', long(), 'item_1', 1400);
    assert.ok(r);
    assert.equal(r!.sameItem, true);
  });

  test('разные реплики повтором не считаются', () => {
    const w = new RepeatWatch();
    w.note('assistant', long('a'), 'item_1', 1000);
    assert.equal(w.note('assistant', long('b'), 'item_2', 2000), null);
  });

  // Роль — часть ключа: человек, повторивший слова ассистента, не дефект.
  test('одна и та же фраза от разных ролей — не повтор', () => {
    const w = new RepeatWatch();
    w.note('assistant', long(), 'item_1', 1000);
    assert.equal(w.note('user', long(), 'item_2', 2000), null);
  });

  // «Да.», «Понял.», «Слушаю.» в живом разговоре повторяются постоянно.
  test('короткие реплики не считаются — иначе счётчик сработает на каждом звонке', () => {
    const w = new RepeatWatch();
    w.note('assistant', 'Да, слушаю.', 'item_1', 1000);
    assert.equal(w.note('assistant', 'Да, слушаю.', 'item_2', 2000), null);
  });

  // Расшифровка одной и той же фразы приходит с разной разбивкой строк.
  test('повтор узнаётся через другую разбивку пробелов', () => {
    const w = new RepeatWatch();
    w.note('assistant', long(), 'item_1', 1000);
    const r = w.note('assistant', `  ${long().replace(' ', '\n\n')}  `, 'item_2', 2000);
    assert.ok(r, 'перенос строки скрыл дословный повтор');
  });

  test('третий повтор отсчитывается от второго, а не от первого', () => {
    const w = new RepeatWatch();
    w.note('assistant', long(), 'item_1', 1000);
    w.note('assistant', long(), 'item_2', 5000);
    const r = w.note('assistant', long(), 'item_3', 9000);
    assert.equal(r!.earlierId, 'item_2');
    assert.equal(r!.sinceMs, 4000);
  });
});

describe('repeatLine', () => {
  test('различает двойную доставку и повторный ответ', () => {
    const base = { role: 'assistant' as const, chars: 314, sinceMs: 10000, id: 'b', earlierId: 'a' };
    assert.match(repeatLine({ ...base, sameItem: true }), /ТА ЖЕ запись/);
    assert.match(repeatLine({ ...base, sameItem: false }), /ДРУГАЯ запись/);
  });

  test('несёт обе записи и разрыв — по ним повтор сверяется с логом Realtime', () => {
    const line = repeatLine({
      role: 'assistant', chars: 314, sinceMs: 10000, id: 'item_b', earlierId: 'item_a', sameItem: false,
    });
    assert.match(line, /item_b/);
    assert.match(line, /item_a/);
    assert.match(line, /10с/);
    assert.match(line, /314 знаков/);
  });

  // Содержимое разговора в логи не попадает — это правило всего voice-host.
  test('текста реплики в строке нет', () => {
    const line = repeatLine({
      role: 'assistant', chars: 60, sinceMs: 1000, id: 'b', earlierId: 'a', sameItem: false,
    });
    assert.ok(!/реплика ассистента/i.test(line));
  });
});
