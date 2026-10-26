import { StudioError } from './errors';
import { SKIT_KINDS, type LineScene, type SceneSpan, type Segment, type SkitKind, type SkitTimeline, type Timeline, type VoicedLine } from './types';

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
/** Клип сценки длиннее — не от Omni (CLIP_LIMITS.maxSec в animate/clip-check.ts): сценарист такое не исправит. */
export const SKIT_CLIP_MAX_MS = 9500;

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

/** Кладёт реплики сцены подряд, с паузой после каждой; возвращает кадр после последней паузы. */
function placeLines(lines: VoicedLine[], scene: LineScene, cursor: number, gap: number, fps: number, segments: Segment[]): number {
  for (const l of lines.filter((x) => x.scene === scene)) {
    const duration = Math.max(1, msToFrames(l.durationMs, fps));
    segments.push({ lineId: l.id, scene, text: l.text, box: l.box, audio: l.audio, from: cursor, duration });
    cursor += duration + gap;
  }
  return cursor;
}

/** Длина ролика в пределах. Секунды — с двумя знаками: с одним 749 кадров выходили «25.0 с — короче 25 с». */
function assertTotal(frames: number, fps: number, minMs: number, maxMs: number, detail = ''): void {
  const ms = (frames / fps) * 1000;
  const sec = `${(frames / fps).toFixed(2)} с`;
  if (ms < minMs) throw new StudioError('too_short', `timeline: ролик ${sec} — короче ${minMs / 1000} с${detail}`, false);
  if (ms > maxMs) throw new StudioError('too_long', `timeline: ролик ${sec} — длиннее ${maxMs / 1000} с${detail}`, false);
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
    cursor = placeLines(lines, scene, cursor, gap, fps, segments);
    if (scene === 'hook') cursor = Math.max(cursor, from + msToFrames(MIN_HOOK_MS, fps));
    scenes[scene] = { from, duration: cursor - from };
  }
  assertTotal(cursor, fps, MIN_TOTAL_MS, MAX_TOTAL_MS);
  return { segments, scenes, totalFrames: cursor };
}

/**
 * Таймлайн ролика со сценками: конфликт (клип) → вопрос → ответ → развязка
 * (клип) → финал. Длину сценок задают клипы, длину остального — озвучка.
 * Реплики hook нет: зацепка — немая надпись поверх первых SKIT_HOOK_MS
 * конфликта. В каждой озвученной сцене хотя бы одна реплика; ролик обязан
 * уложиться в 25–45 с. Пауза GAP_MS — только после реплик: на стыке с клипом
 * паузой служит тишина на краю самого клипа (до 2,4 с, CLIP_LIMITS в
 * animate/clip-check.ts).
 */
export function buildSkitTimeline(lines: VoicedLine[], clips: Record<SkitKind, number>, fps = FPS): SkitTimeline {
  if (lines.some((l) => l.scene === 'hook')) {
    throw new StudioError('script_invalid', 'timeline: у ролика со сценками зацепка — надпись поверх сценки, реплики hook быть не должно', false);
  }
  // Длины клипов приходят из animation.json: NaN молча отключил бы проверку 25–45 с,
  // клип короче зацепки обрезал бы надпись, а слишком длинный ушёл бы сценаристу
  // как «сократите озвучку». CLIP_LIMITS сюда не импортируется:
  // timeline.ts входит в бандл Remotion, а clip-check.ts тянет node:child_process.
  for (const kind of SKIT_KINDS) {
    const ms = clips[kind];
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < SKIT_HOOK_MS || ms > SKIT_CLIP_MAX_MS) {
      throw new StudioError(
        'no_input',
        `timeline: клип сценки ${kind} — ${JSON.stringify(ms) ?? 'нет'} мс, нужен ${SKIT_HOOK_MS / 1000}–${SKIT_CLIP_MAX_MS / 1000} с: переснимите (npm run animate)`,
        false,
      );
    }
  }
  assertOrder(lines, SKIT_LINE_ORDER);
  assertAnswerLines(lines);

  const gap = msToFrames(GAP_MS, fps);
  const segments: Segment[] = [];
  let cursor = 0;
  const clip = (kind: SkitKind): SceneSpan => {
    const span = { from: cursor, duration: msToFrames(clips[kind], fps) };
    cursor += span.duration;
    return span;
  };
  const voiced = (scene: LineScene): SceneSpan => {
    const from = cursor;
    cursor = placeLines(lines, scene, cursor, gap, fps, segments);
    return { from, duration: cursor - from };
  };
  // Порядок вызовов — порядок сцен в ролике. Объект собирается целиком: пропущенную сцену заметит tsc.
  const conflict = clip('conflict');
  const question = voiced('question');
  const answer = voiced('answer');
  const punchline = clip('punchline');
  const final = voiced('final');
  const scenes: SkitTimeline['scenes'] = { conflict, question, answer, punchline, final };
  // Сценаристу важна разбивка: сократить или удлинить он может только озвучку.
  const clipFrames = conflict.duration + punchline.duration;
  assertTotal(cursor, fps, SKIT_MIN_TOTAL_MS, SKIT_MAX_TOTAL_MS, ` (сценки ${(clipFrames / fps).toFixed(2)} с, озвучка ${((cursor - clipFrames) / fps).toFixed(2)} с)`);
  return { segments, scenes, totalFrames: cursor };
}
