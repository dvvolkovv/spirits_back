import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeInfo, Silence } from '../ffprobe';
import { CLIP_SEC } from './google';

const run = promisify(execFile);

/**
 * Пределы клипа сценки. Тишина до 3 с: между репликами сценки бывают паузы.
 * Стартовое значение; сверяется на ролике-образце.
 */
export const CLIP_LIMITS = { minSec: CLIP_SEC - 1.5, maxSec: CLIP_SEC + 1.5, maxSilenceSec: 3 };

/**
 * Громкость клипов, LUFS. Стартовая; на образце сверяется с голосом SpeechKit
 * (ffmpeg -af ebur128), чтобы после живой сценки ответ не звучал тише или громче.
 */
export const CLIP_LUFS = -16;

export function checkClip(probe: ProbeInfo, silences: Silence[]): string[] {
  const problems: string[] = [];
  if (!(probe.durationSec >= CLIP_LIMITS.minSec && probe.durationSec <= CLIP_LIMITS.maxSec)) {
    problems.push(`длина ${probe.durationSec.toFixed(1)} с вне ${CLIP_LIMITS.minSec}–${CLIP_LIMITS.maxSec} с`);
  }
  if (!probe.width || !probe.height) problems.push('нет видеодорожки');
  else if (probe.height <= probe.width) problems.push(`кадр ${probe.width}×${probe.height} не вертикальный`);
  if (!probe.hasAudio) problems.push('нет звука');
  for (const s of silences) {
    if (s.duration > CLIP_LIMITS.maxSilenceSec) problems.push(`тишина ${s.duration.toFixed(1)} с с ${s.start.toFixed(1)} с`);
  }
  return problems;
}

/** Громкость клипа — к CLIP_LUFS; видео не перекодируется. */
export async function normalizeLoudness(input: string, output: string, lufs = CLIP_LUFS): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-c:v', 'copy', '-af', `loudnorm=I=${lufs}:TP=-1.5:LRA=11`, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k',
    output,
  ]);
}
