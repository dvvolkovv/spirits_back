import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

/**
 * Громкость готового ролика — к норме площадок. Приём двух проходов loudnorm
 * и повтора при выбросе пика — из ffmpeg-skill (scripts/loudness.py).
 */
const run = promisify(execFile);

/**
 * Норма Shorts, Reels и TikTok: −14 LUFS, пик не выше −1 dBTP. YouTube громкое
 * приглушает, а тихое не поднимает, Telegram не выравнивает вовсе. Без этого
 * шага ролик звучал на −19,5 LUFS — так звучит голос SpeechKit, к нему же
 * выровнены клипы сценок (CLIP_LUFS), — на 5,5 дБ тише соседей в ленте
 * (замер трёх образцов 30.10.2026).
 */
export const MASTER = { lufs: -14, tp: -1, lra: 11 } as const;

export type LoudnessTarget = { lufs: number; tp: number; lra: number };

/** Допуск пика: замеры одного файла расходятся на столько. */
const TP_TOLERANCE_DB = 0.1;

/** Потолок пика для loudnorm ниже нормы: кодер AAC после loudnorm добавляет свой выброс. */
const TP_HEADROOM_DB = 0.5;

export interface Loudness {
  /** Интегральная громкость, LUFS; −Infinity — тишина. */
  i: number;
  /** Истинный пик, dBTP. */
  tp: number;
  lra: number;
  thresh: number;
  /** Поправка первого прохода для второго. */
  offset: number;
}

export interface Mastered {
  before: Loudness;
  /** Замер готового файла. */
  after: Loudness;
}

const FIELDS = { i: 'input_i', tp: 'input_tp', lra: 'input_lra', thresh: 'input_thresh', offset: 'target_offset' } as const;

/** Замер loudnorm (print_format=json) из stderr ffmpeg. −inf и inf у тишины — бесконечности. */
export function parseLoudnorm(stderr: string): Loudness {
  const out = {} as Loudness;
  for (const [key, name] of Object.entries(FIELDS) as Array<[keyof Loudness, string]>) {
    const m = stderr.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
    if (!m) throw new Error(`loudnorm: в выводе ffmpeg нет ${name}`);
    const v = m[1] === '-inf' ? -Infinity : m[1] === 'inf' ? Infinity : Number(m[1]);
    if (Number.isNaN(v)) throw new Error(`loudnorm: ${name} = ${m[1]}`);
    out[key] = v;
  }
  return out;
}

/** Замер громкости файла — первый проход loudnorm. От цели зависит только offset. */
export async function measureLoudness(file: string, target: LoudnessTarget = MASTER): Promise<Loudness> {
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', `loudnorm=I=${target.lufs}:TP=${target.tp}:LRA=${target.lra}:print_format=json`, '-f', 'null', '-'],
    { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  return parseLoudnorm(stderr);
}

/**
 * Второй проход: громкость к цели по замеру первого. linear — ровный подъём, пока
 * его пускает потолок пика; иначе loudnorm сам переходит в динамический режим (на
 * роликах почти всегда: подъём на 5,5 дБ выводит пик за потолок). Видео
 * копируется как есть. apad и -shortest — как в normalizeLoudness
 * (animate/clip-check.ts): без добивки тишиной выдача буфера loudnorm в конце
 * сдвигает звук последних секунд. +faststart — moov в начале, как у Remotion:
 * иначе ffmpeg переложил бы его в конец, и ролик в Telegram и браузере не играл
 * бы до загрузки целиком.
 */
async function applyLoudness(input: string, output: string, m: Loudness, target: LoudnessTarget, ceiling: number): Promise<void> {
  const filter =
    `apad,loudnorm=I=${target.lufs}:TP=${ceiling}:LRA=${target.lra}` +
    `:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true`;
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy', '-af', filter, '-ar', '48000', '-c:a', 'aac', '-b:a', '256k',
    '-shortest', '-movflags', '+faststart', output,
  ], { timeout: 120_000 });
}

/**
 * Потолок пика для повтора, если пик готового файла вышел за норму (выброс кодера
 * AAC): ниже прежнего на выброс и допуск. null — пик в норме, повтор не нужен.
 */
export function nextCeiling(ceiling: number, afterTp: number, target: LoudnessTarget = MASTER): number | null {
  const over = afterTp - target.tp;
  if (over <= TP_TOLERANCE_DB) return null;
  return Math.round((ceiling - over - TP_TOLERANCE_DB) * 100) / 100;
}

/**
 * Готовый ролик → норма площадок: замер, второй проход, замер итога; пик после
 * кодера вышел за норму — один повтор с потолком ниже. Тишина (−inf) — файл
 * копируется как есть: выравнивать нечего, а пустой звук назовёт проверка
 * ролика (verifyVideo).
 */
export async function masterLoudness(input: string, output: string, target: LoudnessTarget = MASTER): Promise<Mastered> {
  let ceiling = target.tp - TP_HEADROOM_DB;
  const before = await measureLoudness(input, { ...target, tp: ceiling });
  if (!Number.isFinite(before.i)) {
    await fs.promises.copyFile(input, output);
    return { before, after: before };
  }
  await applyLoudness(input, output, before, target, ceiling);
  let after = await measureLoudness(output, target);
  const lower = nextCeiling(ceiling, after.tp, target);
  if (lower !== null) {
    ceiling = lower;
    await applyLoudness(input, output, await measureLoudness(input, { ...target, tp: ceiling }), target, ceiling);
    after = await measureLoudness(output, target);
  }
  return { before, after };
}

/** Строка для лога: громкость и пик до и после выравнивания. */
export function describeLoudness(m: Mastered): string {
  if (!Number.isFinite(m.before.i)) return 'громкость: тишина, не выравнивалась';
  const f = (v: number) => v.toFixed(1);
  return `громкость ${f(m.before.i)} → ${f(m.after.i)} LUFS, пик ${f(m.before.tp)} → ${f(m.after.tp)} dBTP`;
}
