/**
 * Unit-tests for referral commission tier ladder (referral.service.ts tierPct).
 * Owner-confirmed 2026-06-27: 0–4 → 10%, 5–14 → 12%, 15+ → 15%.
 * Inline copy (same approach as other unit tests — no TS import).
 *
 * Run: cd tests && npx jest unit/
 */
const COMMISSION_TIERS = [
  { min: 15, pct: 15 },
  { min: 5, pct: 12 },
  { min: 0, pct: 10 },
];
function tierPct(paidReferees) {
  for (const t of COMMISSION_TIERS) if (paidReferees >= t.min) return t.pct;
  return 10;
}

describe('referral tierPct', () => {
  test('base tier 10% for 0–4 paid referees', () => {
    [0, 1, 4].forEach((n) => expect(tierPct(n)).toBe(10));
  });
  test('12% at 5–14', () => {
    [5, 9, 14].forEach((n) => expect(tierPct(n)).toBe(12));
  });
  test('15% at 15+', () => {
    [15, 30, 100].forEach((n) => expect(tierPct(n)).toBe(15));
  });
  test('monotonic non-decreasing', () => {
    for (let n = 1; n <= 30; n++) expect(tierPct(n)).toBeGreaterThanOrEqual(tierPct(n - 1));
  });
});
