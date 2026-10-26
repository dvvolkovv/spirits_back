import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioError, WRITER_FEEDBACK_CODES, toStudioError } from './errors';
import { buildTimeline } from './timeline';
import type { VoicedLine } from './types';

test('StudioError несёт код и признак повтора', () => {
  const e = new StudioError('answer_rejected', 'capture: ответ не годится', true);
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'StudioError');
  assert.equal(e.code, 'answer_rejected');
  assert.equal(e.retryable, true);
});

test('незнакомая ошибка — unknown с повтором; StudioError проходит как есть', () => {
  const known = new StudioError('tts', 'x', false);
  assert.equal(toStudioError(known), known);
  const wrapped = toStudioError(new Error('ECONNRESET'));
  assert.deepEqual([wrapped.code, wrapped.retryable, wrapped.message], ['unknown', true, 'ECONNRESET']);
  assert.equal(toStudioError('строка').message, 'строка');
});

test('длина озвучки и отвергнутый студией сценарий — к сценаристу, а не в повтор сборки', () => {
  for (const code of ['too_long', 'too_short', 'line_too_short', 'script_invalid'] as const) assert.ok(WRITER_FEEDBACK_CODES.has(code));
  assert.ok(!WRITER_FEEDBACK_CODES.has('answer_rejected'));
});

const line = (id: string, scene: VoicedLine['scene'], durationMs: number, box?: number): VoicedLine => ({
  id, scene, text: id, durationMs, audio: `voice/${id}.mp3`, ...(box ? { box } : {}),
});

test('таймлайн короче 30 с — too_short без повтора', () => {
  assert.throws(
    () => buildTimeline([line('h', 'hook', 1500), line('q', 'question', 2000), line('a1', 'answer', 3000, 1), line('f', 'final', 2000)]),
    (e: unknown) => e instanceof StudioError && e.code === 'too_short' && !e.retryable,
  );
});

test('таймлайн длиннее 60 с — too_long', () => {
  assert.throws(
    () => buildTimeline([line('h', 'hook', 1500), line('q', 'question', 20000), line('a1', 'answer', 30000, 1), line('f', 'final', 15000)]),
    (e: unknown) => e instanceof StudioError && e.code === 'too_long',
  );
});

test('сцены не по порядку — script_invalid', () => {
  assert.throws(
    () => buildTimeline([line('q', 'question', 2000), line('h', 'hook', 1500)]),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid',
  );
});
