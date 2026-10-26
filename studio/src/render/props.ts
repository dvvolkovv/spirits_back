import path from 'node:path';
import { StudioError } from '../errors';
import { FRAME } from '../frame';
import { buildTimeline, FPS } from '../timeline';
import type { TtsResult } from '../tts';
import type { CaptureResult, Script, ShortProps, VoicedLine } from '../types';

/**
 * Склеивает съёмку, сценарий и озвучку в пропсы композиции Short. Пути к
 * файлам — относительно папки съёмки: она же publicDir бандла, staticFile()
 * ищет файлы в ней.
 */
export function buildProps(capture: CaptureResult, script: Script, voiced: TtsResult[], runDir: string): ShortProps {
  if (capture.answerShotWidth !== FRAME.width) {
    throw new StudioError(
      'frame_size',
      `props: снимок ответа шириной ${capture.answerShotWidth} px, нужен ${FRAME.width} — съёмка шла не в кадре ${FRAME.width}×${FRAME.height}`,
      false,
    );
  }
  const byId = new Map(voiced.map((v) => [v.id, v]));
  const lines: VoicedLine[] = script.lines.map((l) => {
    const v = byId.get(l.id);
    if (!v) throw new Error(`props: нет озвучки реплики ${l.id}`);
    return { ...l, durationMs: v.durationMs, audio: path.relative(runDir, v.file) };
  });
  return {
    fps: FPS,
    hook: script.hook,
    badge: script.badge,
    questionShot: capture.questionShot,
    answerShot: capture.answerShot,
    answerShotHeight: capture.answerShotHeight,
    boxes: capture.boxes,
    timeline: buildTimeline(lines, FPS),
    final: { assistantsCount: script.final.assistantsCount, disclaimer: script.final.disclaimer },
  };
}
