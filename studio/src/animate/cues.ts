import type { Silence } from '../ffprobe';
import type { SkitCue } from '../types';

/**
 * Паузы между репликами в клипе Omni: под репликами у Omni фон (шаги, шорох),
 * поэтому порог выше, чем у проверки провалов звука в готовом ролике.
 * Стартовые значения; сверяются на ролике-образце.
 */
export const PAUSE_DETECT = { noise: '-30dB', minSec: 0.25 };

/** Отрезок речи короче этого — щелчок или вздох, а не реплика. */
const MIN_SPAN_MS = 300;

export interface Span {
  startMs: number;
  endMs: number;
}

/** Отрезки речи — промежутки между паузами. */
export function voicedSpans(silences: Silence[], totalMs: number, minMs = MIN_SPAN_MS): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    const start = Math.round(s.start * 1000);
    if (start - cursor >= minMs) spans.push({ startMs: cursor, endMs: start });
    cursor = Math.max(cursor, Math.round(s.end * 1000));
  }
  if (totalMs - cursor >= minMs) spans.push({ startMs: cursor, endMs: totalMs });
  return spans;
}

/**
 * Время субтитров реплик сценки. Отрезков речи столько же, сколько реплик, —
 * реплика на отрезок. Иначе речь (от начала первого отрезка до конца
 * последнего; без отрезков — весь клип) делится пропорционально длине реплик.
 */
export function lineCues(lines: string[], spans: Span[], totalMs: number): SkitCue[] {
  if (!lines.length) return [];
  if (spans.length === lines.length) return spans.map((s, i) => ({ line: i, startMs: s.startMs, endMs: s.endMs }));
  const from = spans.length ? spans[0].startMs : 0;
  const to = spans.length ? spans[spans.length - 1].endMs : totalMs;
  const weights = lines.map((l) => Math.max(1, l.length));
  const total = weights.reduce((n, w) => n + w, 0);
  const cues: SkitCue[] = [];
  let at = from;
  lines.forEach((_, i) => {
    const end = i === lines.length - 1 ? to : Math.round(at + ((to - from) * weights[i]) / total);
    cues.push({ line: i, startMs: at, endMs: end });
    at = end;
  });
  return cues;
}
