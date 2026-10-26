import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineCues, voicedSpans } from './cues';

test('отрезки речи — между паузами; щелчки короче 300 мс отброшены', () => {
  const silences = [
    { start: 0, end: 0.4, duration: 0.4 },
    { start: 3.0, end: 3.6, duration: 0.6 },
    { start: 3.8, end: 4.5, duration: 0.7 },
    { start: 7.2, end: 8.0, duration: 0.8 },
  ];
  assert.deepEqual(voicedSpans(silences, 8000), [
    { startMs: 400, endMs: 3000 },
    { startMs: 4500, endMs: 7200 },
  ]);
});

test('без пауз — один отрезок на весь клип', () => {
  assert.deepEqual(voicedSpans([], 8000), [{ startMs: 0, endMs: 8000 }]);
});

test('отрезков столько же, сколько реплик, — реплика на отрезок', () => {
  const spans = [
    { startMs: 400, endMs: 3000 },
    { startMs: 4500, endMs: 7200 },
  ];
  assert.deepEqual(lineCues(['Обои потёрли!', 'Спокойно.'], spans, 8000), [
    { line: 0, startMs: 400, endMs: 3000 },
    { line: 1, startMs: 4500, endMs: 7200 },
  ]);
});

test('иначе речь от первого отрезка до последнего делится пропорционально длине реплик', () => {
  assert.deepEqual(lineCues(['aaaa', 'aa'], [{ startMs: 1000, endMs: 7000 }], 8000), [
    { line: 0, startMs: 1000, endMs: 5000 },
    { line: 1, startMs: 5000, endMs: 7000 },
  ]);
});

test('отрезков нет — делится весь клип; реплик нет — субтитров нет', () => {
  assert.deepEqual(lineCues(['a', 'b'], [], 8000), [
    { line: 0, startMs: 0, endMs: 4000 },
    { line: 1, startMs: 4000, endMs: 8000 },
  ]);
  assert.deepEqual(lineCues([], [{ startMs: 0, endMs: 8000 }], 8000), []);
});

test('паузы не по порядку, перекрытые и вложенные — отрезки всё равно по порядку и без пересечений', () => {
  const silences = [
    { start: 5.0, end: 6.0, duration: 1.0 },
    { start: 1.0, end: 2.0, duration: 1.0 },
    { start: 1.5, end: 2.5, duration: 1.0 },
    { start: 5.2, end: 5.4, duration: 0.2 },
  ];
  assert.deepEqual(voicedSpans(silences, 8000), [
    { startMs: 0, endMs: 1000 },
    { startMs: 2500, endMs: 5000 },
    { startMs: 6000, endMs: 8000 },
  ]);
});

test('тишина на весь клип — отрезков нет; отрезок ровно 300 мс остаётся, 299 мс — нет; пауза за концом клипа не тянет отрезок', () => {
  assert.deepEqual(voicedSpans([{ start: 0, end: 8, duration: 8 }], 8000), []);
  assert.deepEqual(voicedSpans([{ start: 0.3, end: 8, duration: 7.7 }], 8000), [{ startMs: 0, endMs: 300 }]);
  assert.deepEqual(voicedSpans([{ start: 0.299, end: 8, duration: 7.701 }], 8000), []);
  assert.deepEqual(voicedSpans([{ start: 8.3, end: 8.6, duration: 0.3 }], 8000), [{ startMs: 0, endMs: 8000 }]);
});

test('в репликах по два предложения — граница встаёт в паузу между героями, а не посреди речи', () => {
  const lines = ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'];
  const spans = [
    { startMs: 500, endMs: 1200 },
    { startMs: 1500, endMs: 4200 },
    { startMs: 4600, endMs: 5400 },
    { startMs: 5700, endMs: 6600 },
  ];
  assert.deepEqual(lineCues(lines, spans, 8000), [
    { line: 0, startMs: 500, endMs: 4200 },
    { line: 1, startMs: 4600, endMs: 6600 },
  ]);
});

test('отрезков столько же, сколько реплик, но случайно (стук и слитная речь) — делится по длине текста', () => {
  const lines = ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'];
  assert.deepEqual(lineCues(lines, [{ startMs: 300, endMs: 700 }, { startMs: 1500, endMs: 6000 }], 8000), [
    { line: 0, startMs: 300, endMs: 3036 },
    { line: 1, startMs: 3036, endMs: 6000 },
  ]);
});

test('три реплики и лишние паузы — каждой следующей границе остаётся своя пауза', () => {
  const spans = [
    { startMs: 0, endMs: 300 },
    { startMs: 600, endMs: 900 },
    { startMs: 1200, endMs: 1500 },
    { startMs: 1800, endMs: 9000 },
  ];
  assert.deepEqual(lineCues(['abc', 'abc', 'abc'], spans, 9000), [
    { line: 0, startMs: 0, endMs: 900 },
    { line: 1, startMs: 1200, endMs: 1500 },
    { line: 2, startMs: 1800, endMs: 9000 },
  ]);
});
