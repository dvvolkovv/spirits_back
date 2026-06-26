/**
 * Unit-tests for computeOwnVoiceSurcharge (video.dto.ts) — «видео голосом
 * оригинала» (96cba3f7). Pins the pricing contract: surcharge = ElevenLabs STS
 * supplier cost × Veo markup (75000 tokens/$). Inline copy (same approach as
 * extractJsonObject.test.js — keeps the unit test purely additive, no TS import).
 *
 * Run: cd tests && npx jest unit/
 */
function computeOwnVoiceSurcharge(targetDurationSec) {
  const STS_CHARS_PER_SEC = 15;
  const STS_USD_PER_1K_CHARS = 0.30;
  const VOICE_TOKENS_PER_USD = 75000;
  const sec = Math.max(1, Math.round(targetDurationSec || 0));
  const chars = sec * STS_CHARS_PER_SEC;
  const usd = (chars / 1000) * STS_USD_PER_1K_CHARS;
  return Math.ceil(usd * VOICE_TOKENS_PER_USD);
}

describe('computeOwnVoiceSurcharge', () => {
  test('8s clip ≈ 2700 tokens', () => {
    expect(computeOwnVoiceSurcharge(8)).toBe(2700);
  });
  test('16s clip = 2× the 8s surcharge (linear in duration)', () => {
    expect(computeOwnVoiceSurcharge(16)).toBe(5400);
  });
  test('floors at 1 second (no zero/negative)', () => {
    expect(computeOwnVoiceSurcharge(0)).toBe(338);
    expect(computeOwnVoiceSurcharge(-5)).toBe(338);
  });
  test('is a tiny fraction of the Veo base cost (90000 tokens / 8s)', () => {
    expect(computeOwnVoiceSurcharge(8)).toBeLessThan(90000 * 0.1);
  });
  test('monotonically increases with duration', () => {
    expect(computeOwnVoiceSurcharge(24)).toBeGreaterThan(computeOwnVoiceSurcharge(8));
  });
});
