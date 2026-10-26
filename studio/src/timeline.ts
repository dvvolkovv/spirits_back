import { StudioError } from './errors';
import type { LineScene, Segment, SkitKind, SkitTimeline, Timeline, VoicedLine } from './types';

export const FPS = 30;
/** Пауза после каждой реплики. */
export const GAP_MS = 250;
/** Зацепка держится не меньше двух секунд, даже если фраза короче. */
export const MIN_HOOK_MS = 2000;
export const MIN_TOTAL_MS = 30_000;
export const MAX_TOTAL_MS = 60_000;
/**
 * Реплика ответа короче — сцена не успевает: переезд к абзацу (MOVE, 15 кадров),
 * появление рамки (10) и удержание приближения перед отпуском (10).
 */
export const MIN_ANSWER_LINE_MS = 1500;
/** Ролик со сценками: 25–45 с (спека сценок, «Ролик»). */
export const SKIT_MIN_TOTAL_MS = 25_000;
export const SKIT_MAX_TOTAL_MS = 45_000;
/** Зацепка ролика со сценками — немая надпись поверх конфликта: её читают, а не слушают, поэтому дольше. */
export const SKIT_HOOK_MS = 3000;

const ORDER: LineScene[] = ['hook', 'question', 'answer', 'final'];
/** Озвученные сцены ролика со сценками: зацепка — надпись поверх конфликта, реплики hook нет. */
const SKIT_LINE_ORDER: LineScene[] = ['question', 'answer', 'final'];

export const msToFrames = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

function assertOrder(lines: VoicedLine[], order: LineScene[]): void {
  let at = 0;
  for (const l of lines) {
    const i = order.indexOf(l.scene);
    if (i < at) throw new StudioError('script_invalid', `timeline: сцена ${l.scene} после ${order[at]}; порядок ${order.join(' → ')}`, false);
    at = i;
  }
  for (const s of order) {
    if (!lines.some((l) => l.scene === s)) throw new StudioError('script_invalid', `timeline: в сцене ${s} нет реплик`, false);
  }
}

function assertAnswerLines(lines: VoicedLine[]): void {
  for (const l of lines) {
    if (l.scene === 'answer' && l.durationMs < MIN_ANSWER_LINE_MS) {
      throw new StudioError(
        'line_too_short',
        `timeline: реплика ${l.id} звучит ${(l.durationMs / 1000).toFixed(1)} с — короче ${MIN_ANSWER_LINE_MS / 1000} с: приближение к абзацу не успеет`,
        false,
      );
    }
  }
}

/**
 * Раскладывает озвученные реплики по кадрам. Длину ролика задаёт озвучка:
 * сцена идёт, пока звучат её реплики, плюс паузы. Порядок сцен —
 * hook → question → answer → final, в каждой хотя бы одна реплика,
 * зацепка — ровно одна. Ролик обязан уложиться в 30–60 с.
 */
export function buildTimeline(lines: VoicedLine[], fps = FPS): Timeline {
  const hooks = lines.filter((l) => l.scene === 'hook');
  if (lines[0]?.scene !== 'hook' || hooks.length !== 1) {
    throw new StudioError('script_invalid', 'timeline: зацепка (hook) — первая и единственная реплика своей сцены', false);
  }
  assertOrder(lines, ORDER);
  assertAnswerLines(lines);

  const gap = msToFrames(GAP_MS, fps);
  const segments: Segment[] = [];
  const scenes = {} as Timeline['scenes'];
  let cursor = 0;
  for (const scene of ORDER) {
    const from = cursor;
    for (const l of lines.filter((x) => x.scene === scene)) {
      const duration = Math.max(1, msToFrames(l.durationMs, fps));
      segments.push({ lineId: l.id, scene, text: l.text, box: l.box, audio: l.audio, from: cursor, duration });
      cursor += duration + gap;
    }
    if (scene === 'hook') cursor = Math.max(cursor, from + msToFrames(MIN_HOOK_MS, fps));
    scenes[scene] = { from, duration: cursor - from };
  }
  const sec = cursor / fps;
  if (sec * 1000 < MIN_TOTAL_MS) throw new StudioError('too_short', `timeline: ролик ${sec.toFixed(1)} с — короче 30 с`, false);
  if (sec * 1000 > MAX_TOTAL_MS) throw new StudioError('too_long', `timeline: ролик ${sec.toFixed(1)} с — длиннее 60 с`, false);
  return { segments, scenes, totalFrames: cursor };
}

/**
 * Таймлайн ролика со сценками: конфликт (клип) → вопрос → ответ → развязка
 * (клип) → финал. Длину сценок задают клипы, длину остального — озвучка.
 */
export function buildSkitTimeline(lines: VoicedLine[], clips: Record<SkitKind, number>, fps = FPS): SkitTimeline {
  if (lines.some((l) => l.scene === 'hook')) {
    throw new StudioError('script_invalid', 'timeline: у ролика со сценками зацепка — надпись поверх сценки, реплики hook нет', false);
  }
  assertOrder(lines, SKIT_LINE_ORDER);
  assertAnswerLines(lines);

  const gap = msToFrames(GAP_MS, fps);
  const segments: Segment[] = [];
  const scenes = {} as SkitTimeline['scenes'];
  let cursor = 0;
  const clip = (kind: SkitKind) => {
    const duration = Math.max(1, msToFrames(clips[kind], fps));
    scenes[kind] = { from: cursor, duration };
    cursor += duration;
  };
  const voiced = (scene: 'question' | 'answer' | 'final') => {
    const from = cursor;
    for (const l of lines.filter((x) => x.scene === scene)) {
      const duration = Math.max(1, msToFrames(l.durationMs, fps));
      segments.push({ lineId: l.id, scene, text: l.text, box: l.box, audio: l.audio, from: cursor, duration });
      cursor += duration + gap;
    }
    scenes[scene] = { from, duration: cursor - from };
  };
  clip('conflict');
  voiced('question');
  voiced('answer');
  clip('punchline');
  voiced('final');

  const sec = cursor / fps;
  if (sec * 1000 < SKIT_MIN_TOTAL_MS) throw new StudioError('too_short', `timeline: ролик ${sec.toFixed(1)} с — короче 25 с`, false);
  if (sec * 1000 > SKIT_MAX_TOTAL_MS) throw new StudioError('too_long', `timeline: ролик ${sec.toFixed(1)} с — длиннее 45 с`, false);
  return { segments, scenes, totalFrames: cursor };
}
