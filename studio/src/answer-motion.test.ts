import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOVE, RING_FADE, RING_INSET, ZOOM, answerMotion, easeInOutCubic, lerpKeys } from './answer-motion';
import { FRAME } from './frame';
import type { ImageBox, Segment } from './types';

const boxes: ImageBox[] = [
  { n: 1, top: 900, height: 300, text: 'a' },
  { n: 2, top: 2400, height: 300, text: 'b' },
];
const seg = (lineId: string, box: number, from: number, duration: number): Segment => ({
  lineId, scene: 'answer', text: lineId, box, audio: `voice/${lineId}.mp3`, from, duration,
});
// Сцена ответа начинается с кадра 200; реплики — 200…439 и 448…687 ролика.
const segments = [seg('a1', 1, 200, 240), seg('a2', 2, 448, 240)];
const at = (frame: number) =>
  answerMotion({ frame, segments, sceneFrom: 200, boxes, imageHeight: 5400, frameHeight: 1920, anchorY: 760 })!;

test('сглаживание и ключевые точки — как interpolate Remotion с clamp', () => {
  assert.deepEqual([easeInOutCubic(0), easeInOutCubic(0.5), easeInOutCubic(1)], [0, 0.5, 1]);
  assert.equal(lerpKeys(-5, [0, 10], [1, 2]), 1);
  assert.equal(lerpKeys(5, [0, 10], [1, 2]), 1.5);
  assert.equal(lerpKeys(50, [0, 10], [1, 2]), 2);
});

test('первая реплика: от верха снимка к абзацу, приближение, затем рамка', () => {
  // Середина абзаца 1 — 1050 px; на линию 760 → сдвиг −290.
  assert.deepEqual([at(0).y, at(0).zoom, at(0).ring], [0, 1, 0]);
  assert.equal(at(MOVE / 2).y, -145);
  assert.deepEqual([at(MOVE).y, at(MOVE).zoom, at(MOVE).ring], [-290, ZOOM, 0]);
  assert.equal(at(MOVE + RING_FADE).ring, 1);
  assert.equal(at(239).box.n, 1);
});

test('к концу реплики приближение отпускается', () => {
  assert.equal(at(240).zoom, 1);
  assert.ok(at(235).zoom > 1 && at(235).zoom < ZOOM);
});

test('вторая реплика едет от первого абзаца ко второму', () => {
  // Середина абзаца 2 — 2550 px → сдвиг 760 − 2550 = −1790.
  assert.equal(at(248).y, -290);
  assert.equal(at(248 + MOVE).y, -1790);
  assert.equal(at(248 + MOVE).box.n, 2);
});

test('без реплик или абзацев — движения нет', () => {
  assert.equal(answerMotion({ frame: 0, segments: [], sceneFrom: 0, boxes, imageHeight: 5400, frameHeight: 1920, anchorY: 760 }), null);
});

test('рамка не уходит за кадр на пике приближения', () => {
  assert.ok(RING_INSET >= (FRAME.width / 2) * (1 - 1 / ZOOM));
});
