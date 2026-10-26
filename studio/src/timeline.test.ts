import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkitTimeline, buildTimeline, MIN_ANSWER_LINE_MS } from './timeline';
import { StudioError } from './errors';
import type { LineScene, VoicedLine } from './types';

const line = (id: string, scene: LineScene, durationMs: number, box?: number): VoicedLine => ({
  id,
  scene,
  text: id,
  durationMs,
  audio: `voice/${id}.mp3`,
  ...(box ? { box } : {}),
});

const sample = (): VoicedLine[] => [
  line('h', 'hook', 1500),
  line('q', 'question', 4000),
  line('a1', 'answer', 8000, 1),
  line('a2', 'answer', 8000, 2),
  line('a3', 'answer', 8000, 3),
  line('f', 'final', 4000),
];

test('сцены идут подряд, зацепка не короче двух секунд', () => {
  const t = buildTimeline(sample(), 30);
  assert.deepEqual(t.scenes.hook, { from: 0, duration: 60 });
  assert.deepEqual(t.scenes.question, { from: 60, duration: 128 });
  assert.deepEqual(t.scenes.answer, { from: 188, duration: 744 });
  assert.deepEqual(t.scenes.final, { from: 932, duration: 128 });
  assert.equal(t.totalFrames, 1060);
});

test('реплика начинается после предыдущей и паузы в 8 кадров', () => {
  const t = buildTimeline(sample(), 30);
  assert.deepEqual(
    t.segments.map((s) => [s.lineId, s.from, s.duration]),
    [['h', 0, 45], ['q', 60, 120], ['a1', 188, 240], ['a2', 436, 240], ['a3', 684, 240], ['f', 932, 120]],
  );
  assert.equal(t.segments[2].box, 1);
  assert.equal(t.segments[2].audio, 'voice/a1.mp3');
});

test('зацепка — первая и единственная', () => {
  assert.throws(() => buildTimeline(sample().slice(1)), /зацепка/);
  assert.throws(() => buildTimeline([line('h0', 'hook', 1000), ...sample()]), /зацепка/);
});

test('сцены не идут в обратном порядке', () => {
  const s = sample();
  assert.throws(() => buildTimeline([s[0], s[2], s[1], ...s.slice(3)]), /порядок/);
});

test('в каждой сцене хотя бы одна реплика', () => {
  assert.throws(() => buildTimeline(sample().filter((l) => l.scene !== 'question')), /question/);
});

test('ролик короче 30 с и длиннее 60 с не собирается', () => {
  const short = [line('h', 'hook', 1000), line('q', 'question', 2000), line('a', 'answer', 3000, 1), line('f', 'final', 2000)];
  assert.throws(() => buildTimeline(short), /короче 30 с/);
  const long = [
    line('h', 'hook', 1000),
    line('q', 'question', 2000),
    line('a1', 'answer', 30000, 1),
    line('a2', 'answer', 30000, 2),
    line('f', 'final', 2000),
  ];
  assert.throws(() => buildTimeline(long), /длиннее 60 с/);
});

test('реплика ответа короче 1,5 с — line_too_short: приближение не успеет', () => {
  const s = sample();
  s[2] = line('a1', 'answer', MIN_ANSWER_LINE_MS - 100, 1);
  assert.throws(
    () => buildTimeline(s),
    (e: unknown) => e instanceof StudioError && e.code === 'line_too_short' && /реплика a1/.test(e.message),
  );
});

const skitLines = (): VoicedLine[] => [line('q', 'question', 4000), line('a1', 'answer', 8000, 1), line('a2', 'answer', 8000, 2), line('f', 'final', 4000)];
const clips = { conflict: 8000, punchline: 8000 };

test('сценки: конфликт → вопрос → ответ → развязка → финал', () => {
  const t = buildSkitTimeline(skitLines(), clips, 30);
  assert.deepEqual(t.scenes.conflict, { from: 0, duration: 240 });
  assert.deepEqual(t.scenes.question, { from: 240, duration: 128 });
  assert.deepEqual(t.scenes.answer, { from: 368, duration: 496 });
  assert.deepEqual(t.scenes.punchline, { from: 864, duration: 240 });
  assert.deepEqual(t.scenes.final, { from: 1104, duration: 128 });
  assert.equal(t.totalFrames, 1232);
  assert.deepEqual(t.segments.map((s) => [s.lineId, s.from]), [['q', 240], ['a1', 368], ['a2', 616], ['f', 1104]]);
});

test('сценки: реплики hook нет — зацепка идёт надписью поверх сценки', () => {
  assert.throws(
    () => buildSkitTimeline([line('h', 'hook', 1500), ...skitLines()], clips, 30),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid',
  );
});

test('сценки: ролик 25–45 с', () => {
  const ls = skitLines();
  const long = [...ls.slice(0, 3), line('a3', 'answer', 8000, 3), ls[3]];
  assert.throws(() => buildSkitTimeline(long, clips, 30), (e: unknown) => e instanceof StudioError && e.code === 'too_long');
  const short = [line('q', 'question', 2000), line('a1', 'answer', 2000, 1), line('f', 'final', 2000)];
  assert.throws(() => buildSkitTimeline(short, { conflict: 6000, punchline: 6000 }, 30), (e: unknown) => e instanceof StudioError && e.code === 'too_short');
});

test('сценки: короткая реплика ответа — line_too_short, как у обычного ролика', () => {
  const ls = skitLines();
  ls[1] = line('a1', 'answer', 1000, 1);
  assert.throws(() => buildSkitTimeline(ls, clips, 30), (e: unknown) => e instanceof StudioError && e.code === 'line_too_short');
});
