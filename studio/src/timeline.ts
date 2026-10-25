import { StudioError } from './errors';
import type { LineScene, Segment, Timeline, VoicedLine } from './types';

export const FPS = 30;
/** Пауза после каждой реплики. */
export const GAP_MS = 250;
/** Зацепка держится не меньше двух секунд, даже если фраза короче. */
export const MIN_HOOK_MS = 2000;
export const MIN_TOTAL_MS = 30_000;
export const MAX_TOTAL_MS = 60_000;

const ORDER: LineScene[] = ['hook', 'question', 'answer', 'final'];

export const msToFrames = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

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
  let at = 0;
  for (const l of lines) {
    const i = ORDER.indexOf(l.scene);
    if (i < at) throw new StudioError('script_invalid', `timeline: сцена ${l.scene} после ${ORDER[at]}; порядок hook → question → answer → final`, false);
    at = i;
  }
  for (const s of ORDER) {
    if (!lines.some((l) => l.scene === s)) throw new StudioError('script_invalid', `timeline: в сцене ${s} нет реплик`, false);
  }

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
