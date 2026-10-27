import type { Silence } from '../ffprobe';
import type { SkitCue } from '../types';

/**
 * Паузы между репликами в клипе Omni: под репликами у Omni фон (шаги, шорох),
 * поэтому порог выше, чем у проверки провалов звука в готовом ролике.
 * Стартовые значения; сверяются на ролике-образце.
 */
export const PAUSE_DETECT = { noiseDb: -30, minSec: 0.25 } as const;

/** Отрезок речи короче этого — щелчок или стук, а не реплика. */
const MIN_SPAN_MS = 300;
/** Во сколько раз доля отрезка в речи может отличаться от доли текста реплики, чтобы считать их парой. */
const SPAN_TEXT_RATIO = 3;

export interface Span {
  startMs: number;
  endMs: number;
}

/**
 * Отрезки речи — промежутки между паузами, по порядку и без пересечений.
 * Паузы могут прийти не по порядку и перекрываться; всё зажимается в клип.
 */
export function voicedSpans(silences: Silence[], totalMs: number, minMs = MIN_SPAN_MS): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    const start = Math.min(totalMs, Math.round(s.start * 1000));
    if (start - cursor >= minMs) spans.push({ startMs: cursor, endMs: start });
    cursor = Math.max(cursor, start, Math.min(totalMs, Math.round(s.end * 1000)));
  }
  if (totalMs - cursor >= minMs) spans.push({ startMs: cursor, endMs: totalMs });
  return spans;
}

const distance = (gap: Span, t: number): number => (t < gap.startMs ? gap.startMs - t : t > gap.endMs ? t - gap.endMs : 0);

/**
 * Время субтитров реплик сценки по отрезкам речи из voicedSpans.
 * - Отрезков столько же, сколько реплик, и доля каждого в речи похожа на долю
 *   текста его реплики (не дальше чем в SPAN_TEXT_RATIO раз), — реплика на отрезок.
 * - Отрезков больше (в реплике два предложения — пауза и внутри) — граница
 *   каждой реплики встаёт в паузу, ближайшую к оценке по длине текста.
 * - Иначе речь от начала первого отрезка до конца последнего (без отрезков —
 *   весь клип) делится по длине текста.
 */
export function lineCues(lines: string[], spans: Span[], totalMs: number): SkitCue[] {
  if (!lines.length) return [];
  const weights = lines.map((l) => Math.max(1, l.length));
  const total = weights.reduce((n, w) => n + w, 0);
  const voiced = spans.reduce((n, s) => n + s.endMs - s.startMs, 0);
  const plausible = spans.every((s, i) => {
    const r = (s.endMs - s.startMs) / voiced / (weights[i] / total);
    return r >= 1 / SPAN_TEXT_RATIO && r <= SPAN_TEXT_RATIO;
  });
  if (spans.length === lines.length && plausible) return spans.map((s, i) => ({ line: i, startMs: s.startMs, endMs: s.endMs }));

  const from = spans.length ? spans[0].startMs : 0;
  const to = spans.length ? spans[spans.length - 1].endMs : totalMs;
  const gaps = spans.slice(1).map((s, i) => ({ startMs: spans[i].endMs, endMs: s.startMs }));
  const snap = spans.length > lines.length;
  const cues: SkitCue[] = [];
  let at = from;
  let acc = 0;
  let next = 0;
  lines.forEach((_, i) => {
    acc += weights[i];
    if (i === lines.length - 1) {
      cues.push({ line: i, startMs: at, endMs: to });
      return;
    }
    const est = from + Math.round(((to - from) * acc) / total);
    if (!snap) {
      cues.push({ line: i, startMs: at, endMs: est });
      at = est;
      return;
    }
    // Каждой следующей границе нужна своя пауза — их и оставляем в запасе.
    const left = lines.length - 2 - i;
    let best = next;
    for (let j = next; j < gaps.length - left; j++) if (distance(gaps[j], est) < distance(gaps[best], est)) best = j;
    cues.push({ line: i, startMs: at, endMs: gaps[best].startMs });
    at = gaps[best].endMs;
    next = best + 1;
  });
  return cues;
}
