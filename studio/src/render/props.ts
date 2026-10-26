import path from 'node:path';
import { captionCues, splitCaption } from '../captions';
import { StudioError } from '../errors';
import { FRAME } from '../frame';
import { buildSkitTimeline, buildTimeline, FPS, msToFrames } from '../timeline';
import type { TtsResult } from '../tts';
import type { CaptureResult, ClipCue, Script, ShortAnimation, ShortProps, SkitClip, SkitKind, SkitShortProps, VoicedLine } from '../types';

function assertFrame(capture: CaptureResult): void {
  if (capture.answerShotWidth !== FRAME.width) {
    throw new StudioError(
      'frame_size',
      `props: снимок ответа шириной ${capture.answerShotWidth} px, нужен ${FRAME.width} — съёмка шла не в кадре ${FRAME.width}×${FRAME.height}`,
      false,
    );
  }
}

function voicedLines(script: Script, voiced: TtsResult[], runDir: string): VoicedLine[] {
  const byId = new Map(voiced.map((v) => [v.id, v]));
  return script.lines.map((l) => {
    const v = byId.get(l.id);
    if (!v) throw new Error(`props: нет озвучки реплики ${l.id}`);
    return { ...l, durationMs: v.durationMs, audio: path.relative(runDir, v.file) };
  });
}

/**
 * Склеивает съёмку, сценарий и озвучку в пропсы композиции Short. Пути к
 * файлам — относительно папки съёмки: она же publicDir бандла, staticFile()
 * ищет файлы в ней.
 */
export function buildProps(capture: CaptureResult, script: Script, voiced: TtsResult[], runDir: string): ShortProps {
  assertFrame(capture);
  return {
    fps: FPS,
    hook: script.hook,
    badge: script.badge,
    questionShot: capture.questionShot,
    answerShot: capture.answerShot,
    answerShotHeight: capture.answerShotHeight,
    boxes: capture.boxes,
    timeline: buildTimeline(voicedLines(script, voiced, runDir), FPS),
    final: { assistantsCount: script.final.assistantsCount, disclaimer: script.final.disclaimer },
  };
}

/** Пропсы композиции SkitShort: то же плюс клипы сценок и субтитры их реплик в кадрах ролика. */
export function buildSkitProps(capture: CaptureResult, script: Script, voiced: TtsResult[], animation: ShortAnimation, runDir: string): SkitShortProps {
  assertFrame(capture);
  const skits = script.skits;
  if (!skits) throw new StudioError('script_invalid', 'props: в сценарии нет сценок', false);
  const clips = {} as Record<SkitKind, SkitClip>;
  for (const kind of ['conflict', 'punchline'] as const) {
    const c = animation.skits[kind];
    if (!c || c.fingerprint !== skits[kind].fingerprint) {
      throw new StudioError('no_input', `props: клип сценки ${kind} не снят под этот сценарий — сначала npm run animate`, false);
    }
    clips[kind] = c;
  }
  const timeline = buildSkitTimeline(voicedLines(script, voiced, runDir), { conflict: clips.conflict.durationMs, punchline: clips.punchline.durationMs }, FPS);
  // Начало и конец реплики переводятся в кадры по отдельности: округление
  // длины давало кадр с двумя субтитрами. Конец не выходит за сценку.
  const cues = (kind: SkitKind): ClipCue[] =>
    clips[kind].cues.flatMap((c) => {
      const scene = timeline.scenes[kind];
      const a = msToFrames(c.startMs, FPS);
      const b = Math.min(msToFrames(c.endMs, FPS), scene.duration);
      if (a >= b) return [];
      const text = skits[kind].skit.lines[c.line]?.text ?? '';
      return captionCues(splitCaption(text), scene.from + a, b - a).map((q, i) => ({ key: `${kind}-${c.line}-${i}`, ...q }));
    });
  return {
    fps: FPS,
    hook: script.hook,
    badge: script.badge,
    questionShot: capture.questionShot,
    answerShot: capture.answerShot,
    answerShotHeight: capture.answerShotHeight,
    boxes: capture.boxes,
    timeline,
    final: { assistantsCount: script.final.assistantsCount, disclaimer: script.final.disclaimer },
    clips: {
      conflict: { video: clips.conflict.clip, cues: cues('conflict') },
      punchline: { video: clips.punchline.clip, cues: cues('punchline') },
    },
  };
}
