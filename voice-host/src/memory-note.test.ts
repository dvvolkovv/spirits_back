import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryNote } from './memory-note.js';

/**
 * Память процесса встречи — в строке [вход].
 *
 * SDK пишет её только выше гигабайта, и 03.11.2026 трёхминутный разговор
 * после правки утечки проверить было нечем: процесс завершился, цифр нет.
 */

const MB = 1024 * 1024;

test('RSS, куча и буферы — в мегабайтах', () => {
  const note = memoryNote({ rss: 137.4 * MB, heapUsed: 38.6 * MB, arrayBuffers: 2.2 * MB });
  assert.equal(note, 'память: rss 137 МБ (куча 39, буферы 2)');
});

test('по умолчанию — память этого процесса', () => {
  assert.match(memoryNote(), /^память: rss \d+ МБ \(куча \d+, буферы \d+\)$/);
});
