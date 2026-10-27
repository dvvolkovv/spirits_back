import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchStop } from './stop';

test('pm2 шлёт сообщение shutdown — остановка после текущего задания, одна строка в журнале', () => {
  const proc = new EventEmitter();
  const lines: string[] = [];
  const stopping = watchStop(proc, (l) => lines.push(l));
  assert.equal(stopping(), false);
  proc.emit('message', { type: 'other' });
  proc.emit('message', 'ping');
  assert.equal(stopping(), false);
  proc.emit('message', 'shutdown');
  proc.emit('message', 'shutdown');
  assert.equal(stopping(), true);
  assert.deepEqual(lines, ['worker: pm2 shutdown — закончу текущее задание и выйду']);
});

test('ручной запуск: SIGINT и SIGTERM — тоже остановка', () => {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const proc = new EventEmitter();
    const lines: string[] = [];
    const stopping = watchStop(proc, (l) => lines.push(l));
    proc.emit(sig);
    assert.equal(stopping(), true);
    assert.deepEqual(lines, [`worker: ${sig} — закончу текущее задание и выйду`]);
  }
});
