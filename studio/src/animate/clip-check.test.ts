import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIP_LIMITS, CLIP_LUFS, checkClip } from './clip-check';

const probe = { durationSec: 8, width: 720, height: 1280, hasAudio: true };

test('нормальный клип Omni проходит', () => {
  assert.deepEqual(checkClip(probe, [{ start: 3, end: 3.8, duration: 0.8 }]), []);
});

test('длина вне 6,5–9,5 с', () => {
  assert.match(checkClip({ ...probe, durationSec: 4 }, []).join(), /длина 4\.0 с/);
  assert.match(checkClip({ ...probe, durationSec: 12 }, []).join(), /длина 12\.0 с/);
});

test('нет видео, кадр не вертикальный, нет звука', () => {
  assert.match(checkClip({ ...probe, width: 0, height: 0 }, []).join(), /нет видеодорожки/);
  assert.match(checkClip({ ...probe, width: 1280, height: 720 }, []).join(), /не вертикальный/);
  assert.match(checkClip({ ...probe, hasAudio: false }, []).join(), /нет звука/);
});

test('тишина длиннее 3 с — реплика не прозвучала', () => {
  assert.match(checkClip(probe, [{ start: 4, end: 7.5, duration: 3.5 }]).join(), /тишина 3\.5 с с 4\.0 с/);
});

test('стартовые пределы и громкость', () => {
  assert.deepEqual(CLIP_LIMITS, { minSec: 6.5, maxSec: 9.5, maxSilenceSec: 3 });
  assert.equal(CLIP_LUFS, -16);
});
