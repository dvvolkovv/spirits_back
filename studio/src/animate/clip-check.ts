import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeInfo, Silence } from '../ffprobe';
import { CLIP_SEC } from './google';

/**
 * Клип сценки перед тем, как взять его в ролик: проверка (длина, вертикальный
 * кадр, звук, тишина) и выравнивание громкости с голосом ассистента.
 */
const run = promisify(execFile);

/**
 * Пределы клипа сценки. Тишина до 3 с: между репликами бывают паузы. На краях
 * клипа строже — 2,4 с: на стыке со сценой рядом тишина складывается с паузой
 * перед голосом ассистента, и её поймала бы уже проверка готового ролика.
 * Стартовые значения; сверяются на ролике-образце.
 */
export const CLIP_LIMITS = { minSec: CLIP_SEC - 1.5, maxSec: CLIP_SEC + 1.5, maxSilenceSec: 3, maxEdgeSilenceSec: 2.4 };

/**
 * Громкость клипов, LUFS: голос SpeechKit в роликах плана 2 звучит на −19,5
 * (замер 26.10.2026), клип Omni без выравнивания — около −16. Стартовая; на
 * образце сверяется (ffmpeg -af ebur128).
 */
export const CLIP_LUFS = -19;

/**
 * Проблемы клипа; пустой список — клип годен. Тишина — из detectSilences с
 * порогами по умолчанию (−45 дБ, от 0,5 с), по уже выровненному клипу.
 */
export function checkClip(probe: ProbeInfo, silences: Silence[]): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(probe.durationSec) || probe.durationSec <= 0) {
    problems.push('длина не определена — ffprobe не вернул длительность');
  } else if (probe.durationSec < CLIP_LIMITS.minSec || probe.durationSec > CLIP_LIMITS.maxSec) {
    problems.push(`длина ${probe.durationSec.toFixed(1)} с вне ${CLIP_LIMITS.minSec}–${CLIP_LIMITS.maxSec} с`);
  }
  if (!probe.width || !probe.height) problems.push('нет видеодорожки');
  else if (probe.height <= probe.width) problems.push(`кадр ${probe.width}×${probe.height} не вертикальный`);
  if (!probe.hasAudio) problems.push('нет звука');
  for (const s of silences) {
    const edge = s.start <= 0.05 || (Number.isFinite(probe.durationSec) && s.end >= probe.durationSec - 0.05);
    const limit = edge ? CLIP_LIMITS.maxEdgeSilenceSec : CLIP_LIMITS.maxSilenceSec;
    if (s.duration > limit) problems.push(`тишина ${s.duration.toFixed(1)} с с ${s.start.toFixed(1)} с${edge ? ' (на краю клипа)' : ''}`);
  }
  return problems;
}

/**
 * Громкость клипа — к CLIP_LUFS, видео не перекодируется. Запас тишины (apad)
 * уводит выдачу буфера loudnorm за конец клипа: без него метки времени звука
 * в последних секундах сдвигаются, и Remotion срезает конец. -shortest
 * обрезает звук по видео.
 */
export async function normalizeLoudness(input: string, output: string, lufs = CLIP_LUFS): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-c:v', 'copy', '-af', `apad=pad_dur=3,loudnorm=I=${lufs}:TP=-1.5:LRA=11`, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', output,
  ]);
}
