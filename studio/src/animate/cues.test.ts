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
