import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { botFailureReason } from './attendee-reason.js';

/**
 * Строка отсюда видна человеку в чате («Звонок не состоялся: …»), поэтому
 * тесты проверяют не формат, а понятность: два разных исхода не должны
 * выглядеть одинаково, а незнакомый код не должен пропадать.
 */
describe('botFailureReason', () => {
  test('«не впустили» больше не выглядит как поломка', () => {
    // Ровно этот случай оба раза видел владелец 09.09.2026, и оба раза в базе
    // оказывалось «бот Attendee: fatal_error».
    const r = botFailureReason('fatal_error', 'request_to_join_denied');
    assert.match(r, /не впустили/);
    // Код остаётся: перевод — человеку, код — тому, кто пойдёт в логи.
    assert.match(r, /request_to_join_denied/);
  });

  test('поломка моста и «не впустили» различимы', () => {
    const denied = botFailureReason('fatal_error', 'request_to_join_denied');
    const broken = botFailureReason('fatal_error', 'process_terminated');
    assert.notEqual(denied, broken);
    assert.match(broken, /перезапустил/);
  });

  test('незнакомый код не теряется', () => {
    // Молча превратить его в «что-то пошло не так» значит остаться без
    // единственной зацепки: список подтипов у Attendee растёт.
    const r = botFailureReason('fatal_error', 'zoom_sdk_internal_error');
    assert.match(r, /zoom_sdk_internal_error/);
    assert.match(r, /fatal_error/);
  });

  test('без кода — как было', () => {
    // Вебхуки старых версий подтипа не присылают; ломаться на этом нельзя.
    assert.equal(botFailureReason('ended'), 'бот Attendee: ended');
  });

  test('пустой код не превращается в скобки с пустотой', () => {
    assert.equal(botFailureReason('fatal_error', ''), 'бот Attendee: fatal_error');
  });
});
