import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HARD_CAP_MS, LOBBY_MS, Occupancy } from './occupancy.js';

describe('Occupancy', () => {
  test('пустая комната сразу после входа — не повод выходить', () => {
    assert.equal(new Occupancy(0).verdict(1000), 'stay');
  });

  test('никто не пришёл за время ожидания — вход не состоялся', () => {
    assert.equal(new Occupancy(0).verdict(LOBBY_MS + 1), 'never_started');
  });

  test('на самой границе ожидания ещё держимся', () => {
    assert.equal(new Occupancy(0).verdict(LOBBY_MS - 1), 'stay');
  });

  test('пришёл человек — ожидание больше не действует', () => {
    const occ = new Occupancy(0);
    occ.joined('alice');
    assert.equal(occ.verdict(LOBBY_MS + 1), 'stay');
  });

  test('все ушли — выходим', () => {
    const occ = new Occupancy(0);
    occ.joined('alice');
    occ.left('alice');
    assert.equal(occ.verdict(5000), 'empty');
  });

  test('ушёл один из двух — остаёмся', () => {
    const occ = new Occupancy(0);
    occ.joined('alice');
    occ.joined('bob');
    occ.left('alice');
    assert.equal(occ.verdict(5000), 'stay');
  });

  test('вернувшийся участник отменяет выход', () => {
    const occ = new Occupancy(0);
    occ.joined('alice');
    occ.left('alice');
    occ.joined('alice');
    assert.equal(occ.verdict(6000), 'stay');
  });

  test('повторный joined того же участника не удваивает счётчик', () => {
    // LiveKit присылает participantConnected дважды на переподключении.
    // Со счётчиком вместо множества он после этого не дошёл бы до нуля
    // никогда — ассистент остался бы в пустой комнате навсегда.
    const occ = new Occupancy(0);
    occ.joined('alice');
    occ.joined('alice');
    occ.left('alice');
    assert.equal(occ.verdict(5000), 'empty');
  });

  test('left неизвестного участника ничего не ломает', () => {
    const occ = new Occupancy(0);
    occ.joined('alice');
    occ.left('ghost');
    assert.equal(occ.verdict(2000), 'stay');
  });

  test('потолок срабатывает даже при живой встрече', () => {
    const occ = new Occupancy(0);
    occ.joined('alice');
    assert.equal(occ.verdict(HARD_CAP_MS + 1), 'hard_cap');
  });

  test('потолок важнее пустой комнаты — причина выхода не должна врать', () => {
    const occ = new Occupancy(0);
    occ.joined('alice');
    occ.left('alice');
    assert.equal(occ.verdict(HARD_CAP_MS + 1), 'hard_cap');
  });

  test('потолок важнее несостоявшегося входа', () => {
    assert.equal(new Occupancy(0).verdict(HARD_CAP_MS + 1), 'hard_cap');
  });

  test('ожидание короче потолка — иначе оно бы не срабатывало никогда', () => {
    assert.ok(LOBBY_MS < HARD_CAP_MS);
  });

  test('считает от переданного начала, а не от нуля', () => {
    const start = 1_000_000;
    const occ = new Occupancy(start);
    assert.equal(occ.verdict(start + LOBBY_MS - 1), 'stay');
    assert.equal(occ.verdict(start + LOBBY_MS + 1), 'never_started');
  });
});
