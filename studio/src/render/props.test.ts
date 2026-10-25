import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProps } from './props';
import type { CaptureResult, Script } from '../types';
import { StudioError } from '../errors';

const capture: CaptureResult = {
  scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Проверьте договор', followups: [] },
  cabinetUrl: 'https://test.linkeon.io',
  capturedAt: '2026-10-24T00:00:00.000Z',
  questionShot: 'question.png',
  answerShot: 'answer.png',
  answerShotWidth: 1080,
  answerShotHeight: 5400,
  answerText: 'ответ',
  turns: 1,
  boxes: [
    { n: 1, top: 900, height: 300, text: 'a' },
    { n: 2, top: 2400, height: 300, text: 'b' },
  ],
  assistantsCount: 18,
};

const script: Script = {
  hook: 'Юрист нашёл две ловушки',
  voice: 'madirus',
  lines: [
    { id: 'h', scene: 'hook', text: 'Юрист нашёл две ловушки' },
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист.' },
    { id: 'a1', scene: 'answer', text: 'Первая.', box: 1 },
    { id: 'a2', scene: 'answer', text: 'Вторая.', box: 2 },
    { id: 'f', scene: 'final', text: 'Ссылка в описании.', voice: 'alena' },
  ],
  final: { disclaimer: 'Ответ ИИ, не заменяет специалиста' },
};

const ms: Record<string, number> = { h: 1500, q: 4000, a1: 12000, a2: 12000, f: 4000 };

test('пропсы: пути озвучки относительно папки съёмки, финал из съёмки и сценария', () => {
  const voiced = script.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  const p = buildProps(capture, script, voiced, '/run');
  assert.equal(p.timeline.segments[0].audio, 'voice/h.mp3');
  assert.equal(p.answerShotHeight, 5400);
  assert.deepEqual(p.final, { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет специалиста' });
  assert.ok(p.timeline.totalFrames >= 900, `ролик ${p.timeline.totalFrames} кадров — короче 30 с`);
});

test('реплика без озвучки — ошибка', () => {
  const voiced = script.lines.slice(1).map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  assert.throws(() => buildProps(capture, script, voiced, '/run'), /нет озвучки реплики h/);
});

test('снимок ответа не той ширины — frame_size без повтора', () => {
  const voiced = script.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  assert.throws(
    () => buildProps({ ...capture, answerShotWidth: 720 }, script, voiced, '/run'),
    (e: unknown) => e instanceof StudioError && e.code === 'frame_size' && !e.retryable,
  );
});
