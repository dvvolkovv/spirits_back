import { execFileSync, spawnSync } from 'node:child_process';
import { FRAME } from '../frame';

/**
 * Проверки готового ролика для фикстур сборки — требования площадок, записанные
 * независимо от кода студии: громкость меряет ebur128, а не loudnorm студии,
 * зона интерфейса задана здесь, а не взята из кода композиции.
 */

/** Норма Shorts, Reels и TikTok: −14 LUFS ± 1, пик — без перелёта за −1 dBTP (замер ebur128 может разойтись с loudnorm на десятые). */
const PLATFORM = { lufs: -14, lufsTol: 1, maxTp: -0.8 } as const;

/** Нижняя зона интерфейса площадок — подпись, канал, кнопки; у TikTok она выше всех: 22 % высоты кадра. */
const UI_ZONE = Math.ceil(FRAME.height * 0.22);

/** Белый текст финала на зелёном градиенте ярче этого, сам градиент — темнее 130. */
const TEXT_LUMA = 180;

function ebur128(video: string): { i: number; tp: number } {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', video, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  return {
    i: Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]),
    tp: Number(summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]),
  };
}

/** Самая яркая точка строк y0…y1 последнего кадра, 0–255. */
function maxLuma(video: string, y0: number, y1: number): number {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-sseof', '-0.3', '-i', video, '-frames:v', '1', '-vf', `crop=iw:${y1 - y0}:0:${y0},format=gray`, '-f', 'rawvideo', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  let max = 0;
  for (const v of raw) if (v > max) max = v;
  return max;
}

/**
 * Что не так с готовым роликом для площадок: громкость не в норме или в финале
 * текст в нижней зоне интерфейса. Дисклеймер финала обязан остаться — прямо
 * над зоной. Пустой список — годен.
 */
export function deliveryProblems(video: string): string[] {
  const problems: string[] = [];
  const l = ebur128(video);
  if (!(Math.abs(l.i - PLATFORM.lufs) <= PLATFORM.lufsTol)) problems.push(`громкость ${l.i} LUFS, нужна ${PLATFORM.lufs} ± ${PLATFORM.lufsTol}`);
  if (!(l.tp <= PLATFORM.maxTp)) problems.push(`пик ${l.tp} dBTP выше ${PLATFORM.maxTp}`);
  const zone = FRAME.height - UI_ZONE;
  if (maxLuma(video, zone, FRAME.height) >= TEXT_LUMA) problems.push(`в финале текст в нижних ${UI_ZONE} px — под интерфейсом площадок`);
  if (maxLuma(video, zone - 100, zone) < TEXT_LUMA) problems.push('в финале нет дисклеймера над зоной интерфейса');
  return problems;
}
