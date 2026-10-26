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
  const clipOf = (kind: SkitKind): SkitClip => {
    const c = animation.skits?.[kind];
    if (!c || c.fingerprint !== skits[kind].fingerprint) {
      throw new StudioError('no_input', `props: клип сценки ${kind} не снят под этот сценарий — сначала npm run animate`, false);
    }
    return c;
  };
  const clips: Record<SkitKind, SkitClip> = { conflict: clipOf('conflict'), punchline: clipOf('punchline') };
  const timeline = buildSkitTimeline(voicedLines(script, voiced, runDir), { conflict: clips.conflict.durationMs, punchline: clips.punchline.durationMs }, FPS);
  const cues = (kind: SkitKind): ClipCue[] => {
    const { from, duration } = timeline.scenes[kind];
    const lines = skits[kind].skit.lines;
    const got = Array.isArray(clips[kind].cues) ? clips[kind].cues : [];
    // Субтитры сценок обязательны: большинство смотрит без звука. animate пишет по записи
    // на реплику, по порядку; другое — ошибка, а не ролик с пропавшими субтитрами.
    if (got.length !== lines.length || got.some((c, n) => c.line !== n || !Number.isFinite(c.startMs) || !Number.isFinite(c.endMs))) {
      throw new StudioError('no_input', `props: время реплик сценки ${kind} не сходится со сценарием (реплик ${lines.length}, записей ${got.length}) — перезапустите npm run animate`, false);
    }
    // Начало и конец переводятся в кадры по отдельности: округление длины давало кадр
    // с двумя субтитрами. Субтитр не начинается раньше конца предыдущего и не выходит за сценку.
    let prevEnd = 0;
    return got.flatMap((c, n) => {
      const a = Math.max(prevEnd, msToFrames(c.startMs, FPS));
      const b = Math.min(msToFrames(c.endMs, FPS), duration);
      if (a >= b) return [];
      prevEnd = b;
      return captionCues(splitCaption(lines[n].text), from + a, b - a).map((q, i) => ({ key: `${kind}-${n}-${i}`, ...q }));
    });
  };
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
