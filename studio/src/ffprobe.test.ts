import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe, parseSilences, SHORT_LIMITS, SKIT_LIMITS, toDurationMs, verifyVideo } from './ffprobe';

const PROBE = JSON.stringify({
  format: { duration: '41.633333' },
  streams: [{ codec_type: 'video', width: 1080, height: 1920 }, { codec_type: 'audio' }],
});

const SILENCE_LOG = [
  '[silencedetect @ 0x1] silence_start: 3.2',
  '[silencedetect @ 0x1] silence_end: 3.9 | silence_duration: 0.7',
  'frame=   10 fps=0.0 q=-0.0 size=N/A',
  '[silencedetect @ 0x1] silence_start: 38.5',
].join('\n');

test('разбор ffprobe', () => {
  assert.deepEqual(parseProbe(PROBE), { durationSec: 41.633333, width: 1080, height: 1920, hasAudio: true });
});

test('разбор тишины: незакрытая тянется до конца файла', () => {
  assert.deepEqual(parseSilences(SILENCE_LOG, 41.6), [
    { start: 3.2, end: 3.9, duration: 0.7 },
    { start: 38.5, end: 41.6, duration: 41.6 - 38.5 },
  ]);
});

test('годный ролик проходит проверку', () => {
  assert.deepEqual(verifyVideo(parseProbe(PROBE), [{ start: 3.2, end: 3.9, duration: 0.7 }]), []);
});

test('проверка ловит длину, кадр, отсутствие звука и долгую тишину', () => {
  const p = verifyVideo({ durationSec: 25, width: 720, height: 1280, hasAudio: false }, [{ start: 10, end: 13, duration: 3 }]);
  assert.equal(p.length, 4);
  const all = p.join(';');
  assert.match(all, /длина 25.0 с/);
  assert.match(all, /кадр 720×1280/);
  assert.match(all, /нет звуковой дорожки/);
  assert.match(all, /тишина 3.0 с с 10.0 с/);
});

test('неопределённая длительность — проблема, а не тихий пропуск', () => {
  const probe = parseProbe(
    JSON.stringify({ format: { duration: 'N/A' }, streams: [{ codec_type: 'video', width: 1080, height: 1920 }, { codec_type: 'audio' }] }),
  );
  assert.deepEqual(verifyVideo(probe, []), ['длина не определена — ffprobe не вернул длительность']);
});

test('ролик со сценками: 25–45 с, пауза до 3 с — у обычного ролика она была бы провалом', () => {
  const probe = { durationSec: 27, width: 1080, height: 1920, hasAudio: true };
  const pause = [{ start: 10, end: 12.5, duration: 2.5 }];
  assert.deepEqual(verifyVideo(probe, pause, SKIT_LIMITS), []);
  assert.deepEqual(verifyVideo(probe, pause, SHORT_LIMITS), ['длина 27.0 с вне 30–60 с', 'тишина 2.5 с с 10.0 с']);
  assert.deepEqual(verifyVideo({ ...probe, durationSec: 45.1 }, [], SKIT_LIMITS), ['длина 45.1 с вне 25–45 с']);
});

test('длина ролика — по видеодорожке: звук AAC длиннее видео на десятки мс', () => {
  const p = parseProbe(
    JSON.stringify({
      format: { duration: '45.056000' },
      streams: [{ codec_type: 'video', width: 1080, height: 1920, duration: '45.000000' }, { codec_type: 'audio', duration: '45.056000' }],
    }),
  );
  assert.equal(p.videoSec, 45);
  assert.deepEqual(verifyVideo(p, [], SKIT_LIMITS), []);
  assert.deepEqual(verifyVideo({ ...p, videoSec: undefined }, [], SKIT_LIMITS), ['длина 45.1 с вне 25–45 с']);
});

test('длительность озвучки без числа — ошибка с именем файла', () => {
  assert.equal(toDurationMs(1.2345, 'a.mp3'), 1235);
  assert.throws(() => toDurationMs(Number.NaN, 'voice/l1.mp3'), /voice\/l1\.mp3/);
  assert.throws(() => toDurationMs(0, 'voice/l1.mp3'), /длительность/);
});
