import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSilences, probeFile } from './ffprobe';
import { describeLoudness, MASTER, masterLoudness, measureLoudness, parseLoudnorm, type Loudness } from './loudness';

/** Хвост stderr первого прохода loudnorm — снят с ролика-образца skit-sample-1 (30.10.2026). */
const PASS1 = [
  '      handler_name    : SoundHandler',
  '[Parsed_loudnorm_0 @ 0xa9d04ca80] ',
  '{',
  '\t"input_i" : "-19.56",',
  '\t"input_tp" : "-4.63",',
  '\t"input_lra" : "2.60",',
  '\t"input_thresh" : "-30.31",',
  '\t"output_i" : "-14.05",',
  '\t"output_tp" : "-1.50",',
  '\t"output_lra" : "2.10",',
  '\t"output_thresh" : "-24.84",',
  '\t"normalization_type" : "dynamic",',
  '\t"target_offset" : "0.05"',
  '}',
  '[out#0/null @ 0xa9d04c300] video:0KiB audio:24544KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown',
  'size=N/A time=00:00:32.80 bitrate=N/A speed=51.3x elapsed=0:00:00.63    ',
].join('\n');

const SAMPLE: Loudness = { i: -19.56, tp: -4.63, lra: 2.6, thresh: -30.31, offset: 0.05 };

test('разбор замера loudnorm', () => {
  assert.deepEqual(parseLoudnorm(PASS1), SAMPLE);
});

test('тишина: −inf и inf — бесконечности, а не сбой разбора', () => {
  const silent = PASS1.replace('"-19.56"', '"-inf"').replace('"-4.63"', '"-inf"').replace('"0.05"', '"inf"');
  assert.deepEqual(parseLoudnorm(silent), { ...SAMPLE, i: -Infinity, tp: -Infinity, offset: Infinity });
});

test('нет замера в выводе — ошибка с причиной', () => {
  assert.throws(() => parseLoudnorm('Invalid argument'), /loudnorm: в выводе ffmpeg нет input_i/);
  assert.throws(() => parseLoudnorm(PASS1.replace('"-4.63"', '"abc"')), /loudnorm: input_tp = abc/);
});

test('норма площадок: −14 LUFS, пик не выше −1 dBTP', () => {
  assert.deepEqual(MASTER, { lufs: -14, tp: -1, lra: 11 });
});

test('строка для лога: было → стало; тишина — не выравнивалась', () => {
  const after: Loudness = { i: -14.02, tp: -1.31, lra: 2.1, thresh: -24.8, offset: 0 };
  assert.equal(describeLoudness({ before: SAMPLE, after }), 'громкость -19.6 → -14.0 LUFS, пик -4.6 → -1.3 dBTP');
  const silent: Loudness = { ...SAMPLE, i: -Infinity, tp: -Infinity };
  assert.equal(describeLoudness({ before: silent, after: silent }), 'громкость: тишина, не выравнивалась');
});

/** Ролик 8 с, как из Remotion: H.264 + AAC, moov в начале; звук — выражение aevalsrc (моно, 48 кГц). */
function makeVideo(dir: string, expr: string): string {
  const file = path.join(dir, 'render.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=720x1280:r=30:d=8',
    '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=48000:d=8`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', file]);
  return file;
}

/** Контрольная сумма видеодорожки без перекодирования: совпала — видео скопировано как есть. */
const videoMd5 = (file: string): string =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-']).toString().trim();

/** Атомы верхнего уровня MP4 по порядку: moov перед mdat — ролик играет, не дожидаясь загрузки целиком. */
function atoms(file: string): string[] {
  const b = fs.readFileSync(file);
  const out: string[] = [];
  for (let at = 0; at + 8 <= b.length; ) {
    let size = b.readUInt32BE(at);
    if (size === 1) size = Number(b.readBigUInt64BE(at + 8));
    else if (size === 0) size = b.length - at;
    out.push(b.toString('latin1', at + 4, at + 8));
    if (size < 8) break;
    at += size;
  }
  return out;
}

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-master-'));

test('выравнивание: −14 LUFS и пик не выше −1 dBTP; видео — как было, звук не сдвинут, moov в начале', { timeout: 60_000 }, async () => {
  const dir = tmp();
  // Реплики 1–3 с и 6–7,5 с на −26 дБ: сборка тише нормы, как ролики до выравнивания.
  const input = makeVideo(dir, '0.05*sin(2*PI*300*t)*(between(t\\,1\\,3)+between(t\\,6\\,7.5))');
  const output = path.join(dir, 'video.mp4');
  const r = await masterLoudness(input, output);
  assert.ok(r.before.i < -25, `до выравнивания ${r.before.i} LUFS`);
  const after = await measureLoudness(output);
  assert.ok(Math.abs(after.i - MASTER.lufs) <= 1, `после выравнивания ${after.i} LUFS`);
  assert.ok(after.tp <= MASTER.tp + 0.1, `пик ${after.tp} dBTP`);
  assert.deepEqual([r.after.i, r.after.tp], [after.i, after.tp], 'итог — замер готового файла');
  assert.equal(videoMd5(output), videoMd5(input));
  const p = await probeFile(output);
  assert.ok(Math.abs(p.durationSec - 8) < 0.05, `длина ${p.durationSec} с`);
  const silences = await detectSilences(output, p.durationSec);
  const gap = silences.find((s) => s.start > 2.5 && s.start < 3.5);
  assert.ok(gap && Math.abs(gap.end - 6) < 0.02, `реплика 2 началась не в 6,0 с: ${JSON.stringify(silences)}`);
  assert.deepEqual(atoms(output).filter((a) => a === 'moov' || a === 'mdat'), ['moov', 'mdat']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('громкие акценты: ограничитель срезает пик, громкость всё равно −14, пик не выше −1 dBTP', { timeout: 60_000 }, async () => {
  const dir = tmp();
  // Речь на −26 дБ и плавные акценты раз в секунду: линейный подъём на 13 дБ вывел бы пик
  // на +2 dBTP, срезать ≈ 3,5 дБ — как на роликах стенда (1,2–5 дБ). Резкие всплески не
  // годятся: на них выброс кодера AAC 0,9–2,6 дБ (см. TP_HEADROOM_DB в loudness.ts).
  const input = makeVideo(dir, '0.05*sin(2*PI*300*t)*between(t\\,0.5\\,7.5)+0.25*sin(2*PI*600*t)*pow(sin(PI*mod(t\\,1)/0.1)\\,2)*lt(mod(t\\,1)\\,0.1)');
  const output = path.join(dir, 'video.mp4');
  await masterLoudness(input, output);
  const after = await measureLoudness(output);
  assert.ok(Math.abs(after.i - MASTER.lufs) <= 1, `после выравнивания ${after.i} LUFS`);
  assert.ok(after.tp <= MASTER.tp + 0.1, `пик ${after.tp} dBTP`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('тишина — файл как есть и без сбоя: её назовёт проверка ролика', { timeout: 60_000 }, async () => {
  const dir = tmp();
  const input = makeVideo(dir, '0');
  const output = path.join(dir, 'video.mp4');
  const r = await masterLoudness(input, output);
  assert.equal(r.before.i, -Infinity);
  assert.ok(fs.readFileSync(output).equals(fs.readFileSync(input)), 'файл изменился');
  fs.rmSync(dir, { recursive: true, force: true });
});
