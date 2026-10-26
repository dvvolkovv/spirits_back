import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSilences, probeFile } from '../ffprobe';
import { CLIP_LIMITS, CLIP_LUFS, checkClip, normalizeLoudness } from './clip-check';

const probe = { durationSec: 8, width: 720, height: 1280, hasAudio: true };

test('нормальный клип Omni проходит', () => {
  assert.deepEqual(checkClip(probe, [{ start: 3, end: 3.8, duration: 0.8 }]), []);
});

test('длина вне 6,5–9,5 с; границы включительно; NaN — «не определена»', () => {
  assert.deepEqual(checkClip({ ...probe, durationSec: 4 }, []), ['длина 4.0 с вне 6.5–9.5 с']);
  assert.deepEqual(checkClip({ ...probe, durationSec: 12 }, []), ['длина 12.0 с вне 6.5–9.5 с']);
  assert.deepEqual(checkClip({ ...probe, durationSec: 6.5 }, []), []);
  assert.deepEqual(checkClip({ ...probe, durationSec: 9.5 }, []), []);
  assert.deepEqual(checkClip({ ...probe, durationSec: Number.NaN }, []), ['длина не определена — ffprobe не вернул длительность']);
  assert.deepEqual(checkClip({ ...probe, durationSec: 0 }, []), ['длина не определена — ffprobe не вернул длительность']);
});

test('нет видео — ровно одна причина; квадрат и горизонталь — не вертикальный; нет звука', () => {
  assert.deepEqual(checkClip({ ...probe, width: 0, height: 0 }, []), ['нет видеодорожки']);
  assert.deepEqual(checkClip({ ...probe, width: 720, height: 0 }, []), ['нет видеодорожки']);
  assert.deepEqual(checkClip({ ...probe, width: 720, height: 720 }, []), ['кадр 720×720 не вертикальный']);
  assert.deepEqual(checkClip({ ...probe, width: 1280, height: 720 }, []), ['кадр 1280×720 не вертикальный']);
  assert.deepEqual(checkClip({ ...probe, hasAudio: false }, []), ['нет звука']);
});

test('тишина внутри — до 3 с включительно, на краях — до 2,4 с', () => {
  assert.deepEqual(checkClip(probe, [{ start: 4, end: 7, duration: 3 }]), []);
  assert.deepEqual(checkClip(probe, [{ start: 4, end: 7.5, duration: 3.5 }]), ['тишина 3.5 с с 4.0 с']);
  assert.deepEqual(checkClip(probe, [{ start: 0, end: 2.4, duration: 2.4 }]), []);
  assert.deepEqual(checkClip(probe, [{ start: 0, end: 2.6, duration: 2.6 }]), ['тишина 2.6 с с 0.0 с (на краю клипа)']);
  assert.deepEqual(checkClip(probe, [{ start: 5.3, end: 8, duration: 2.7 }]), ['тишина 2.7 с с 5.3 с (на краю клипа)']);
});

test('стартовые пределы и громкость', () => {
  assert.deepEqual(CLIP_LIMITS, { minSec: 6.5, maxSec: 9.5, maxSilenceSec: 3, maxEdgeSilenceSec: 2.4 });
  assert.equal(CLIP_LUFS, -19);
});

test('громкость: звук не сдвигается и не длиннее видео', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-loudnorm-'));
  const raw = path.join(dir, 'raw.mp4');
  const out = path.join(dir, 'clip.mp4');
  // Тон 6,0–6,5 с — в последних трёх секундах; звук 8,05 с при видео 8 с: длина не кратна 100 мс.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=720x1280:r=24:d=8',
    '-f', 'lavfi', '-i', 'aevalsrc=0.05*sin(2*PI*300*t)*between(t\\,6\\,6.5):s=48000:d=8.05',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', raw]);
  await normalizeLoudness(raw, out);
  const p = await probeFile(out);
  assert.ok(Math.abs(p.durationSec - 8) < 0.05, `длина ${p.durationSec} с`);
  const [lead] = await detectSilences(out, p.durationSec);
  assert.ok(Math.abs(lead.end - 6) < 0.02, `тон начался в ${lead.end} с вместо 6,0 с`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('звук короче видео больше чем на 3 с — клип не укорачивается, хвост тишины ловится как край', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-loudnorm-'));
  const raw = path.join(dir, 'raw.mp4');
  const out = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=720x1280:r=24:d=8',
    '-f', 'lavfi', '-i', 'aevalsrc=0.05*sin(2*PI*300*t):s=48000:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', raw]);
  await normalizeLoudness(raw, out);
  const p = await probeFile(out);
  assert.ok(Math.abs(p.durationSec - 8) < 0.05, `длина ${p.durationSec} с`);
  const problems = checkClip(p, await detectSilences(out, p.durationSec));
  assert.ok(problems.some((x) => /на краю клипа/.test(x)), problems.join('; '));
  fs.rmSync(dir, { recursive: true, force: true });
});
