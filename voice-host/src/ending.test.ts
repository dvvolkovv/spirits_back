import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { disconnectName } from './ending.js';

/**
 * ⚠️ Почему ушёл участник — единственное место во всей цепочке, где видно
 * разницу между «человек положил трубку» и «связь порвалась».
 *
 * Сама сессия этого не знает: её CloseReason на оба случая отвечает
 * `participant_disconnected`. Знает LiveKit — у уходящего участника есть своя
 * причина, и приходит она ЧИСЛОМ из livekit_models.DisconnectReason.
 *
 * Имя, а не число, уезжает на бэкенд намеренно: число в базе через полгода
 * никто не прочитает, а разбирать протокольный enum на стороне бэкенда
 * значило бы держать его копию в двух репозиториях.
 */
describe('disconnectName', () => {
  test('клиент сам отключился — это человек нажал «Отбой»', () => {
    assert.equal(disconnectName(1), 'client_initiated');
  });

  test('оборванный websocket и таймаут сервера различимы', () => {
    assert.equal(disconnectName(9), 'signal_close');
    assert.equal(disconnectName(14), 'connection_timeout');
    assert.notEqual(disconnectName(9), disconnectName(1));
  });

  test('наши собственные закрытия названы своими именами', () => {
    assert.equal(disconnectName(4), 'participant_removed');
    assert.equal(disconnectName(5), 'room_deleted');
    assert.equal(disconnectName(3), 'server_shutdown');
  });

  test('⚠️ причины нет — нет и имени: догадываться нельзя', () => {
    assert.equal(disconnectName(undefined), undefined);
    assert.equal(disconnectName(null), undefined);
  });

  test('ноль — это «причина неизвестна», а не отсутствие причины', () => {
    // 0 = UNKNOWN_REASON. Он должен доехать до базы как есть: «мы спросили, и
    // нам ответили „не знаю“» и «мы не спрашивали» — разные вещи при разборе.
    assert.equal(disconnectName(0), 'unknown_reason');
  });

  test('незнакомый код не теряется, а приезжает как есть', () => {
    // Протокол растёт; новый код должен быть виден в базе, а не исчезнуть.
    assert.equal(disconnectName(99), 'code_99');
  });
});
