import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface Silence {
  start: number;
  end: number;
  duration: number;
}

export function parseProbe(json: string): ProbeInfo {
  const data = JSON.parse(json) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  return {
    durationSec: Number(data.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: Boolean(data.streams?.some((s) => s.codec_type === 'audio')),
  };
}

/** Разбор stderr `ffmpeg -af silencedetect`. Незакрытая тишина тянется до конца файла. */
export function parseSilences(stderr: string, totalSec: number): Silence[] {
  const out: Silence[] = [];
  let start: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    if (s) {
      start = Math.max(0, Number(s[1]));
      continue;
    }
    const e = line.match(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/);
    if (e && start != null) {
      out.push({ start, end: Number(e[1]), duration: Number(e[2]) });
      start = null;
    }
  }
  if (start != null) out.push({ start, end: totalSec, duration: totalSec - start });
  return out;
}

export interface VerifyLimits {
  minSec: number;
  maxSec: number;
  width: number;
  height: number;
  maxSilenceSec: number;
}

export const SHORT_LIMITS: VerifyLimits = { minSec: 30, maxSec: 60, width: 1080, height: 1920, maxSilenceSec: 2 };

/**
 * Проверка готового ролика. Тишина длиннее предела — значит, реплика не
 * прозвучала: на мультфильме проверка первых секунд пропустила остановку
 * плеера на 0:23, поэтому смотрим звук по всей длине.
 */
export function verifyVideo(probe: ProbeInfo, silences: Silence[], limits: VerifyLimits = SHORT_LIMITS): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(probe.durationSec)) {
    problems.push('длина не определена — ffprobe не вернул длительность');
  } else if (probe.durationSec < limits.minSec || probe.durationSec > limits.maxSec) {
    problems.push(`длина ${probe.durationSec.toFixed(1)} с вне ${limits.minSec}–${limits.maxSec} с`);
  }
  if (probe.width !== limits.width || probe.height !== limits.height) {
    problems.push(`кадр ${probe.width}×${probe.height}, нужен ${limits.width}×${limits.height}`);
  }
  if (!probe.hasAudio) problems.push('нет звуковой дорожки');
  for (const s of silences) {
    if (s.duration > limits.maxSilenceSec) problems.push(`тишина ${s.duration.toFixed(1)} с с ${s.start.toFixed(1)} с`);
  }
  return problems;
}

export async function probeFile(file: string): Promise<ProbeInfo> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return parseProbe(stdout);
}

export async function detectSilences(file: string, totalSec: number): Promise<Silence[]> {
  // silencedetect пишет в stderr, ffmpeg при этом выходит с кодом 0.
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-45dB:d=0.5', '-f', 'null', '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return parseSilences(stderr, totalSec);
}

/** Длительность в мс. Без неё таймлайн получил бы NaN-кадры — лучше упасть сразу и назвать файл. */
export function toDurationMs(sec: number, file: string): number {
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`ffprobe: не удалось определить длительность ${file}`);
  return Math.round(sec * 1000);
}

export async function audioDurationMs(file: string): Promise<number> {
  return toDurationMs((await probeFile(file)).durationSec, file);
}
