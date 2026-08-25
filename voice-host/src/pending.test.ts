import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PendingAnswers } from './pending.js';

test('offer() returns the text immediately when not speaking', () => {
  const p = new PendingAnswers();
  assert.equal(p.offer('hello'), 'hello');
  assert.equal(p.size, 0);
});

test('offer() queues and returns null while speaking', () => {
  const p = new PendingAnswers();
  p.setSpeaking(true);
  assert.equal(p.offer('a'), null);
  assert.equal(p.offer('b'), null);
  assert.equal(p.size, 2);
});

test('drain() returns the queue in insertion order and empties it', () => {
  const p = new PendingAnswers();
  p.setSpeaking(true);
  p.offer('first');
  p.offer('second');
  p.offer('third');

  assert.deepEqual(p.drain(), ['first', 'second', 'third']);
  assert.equal(p.size, 0);
  assert.deepEqual(p.drain(), []);
});

test('offer() passes through again once speaking stops', () => {
  const p = new PendingAnswers();
  p.setSpeaking(true);
  p.offer('queued while speaking');
  p.setSpeaking(false);

  assert.equal(p.offer('live'), 'live');
  // The earlier queued line is untouched until drain() is called explicitly.
  assert.deepEqual(p.drain(), ['queued while speaking']);
});
