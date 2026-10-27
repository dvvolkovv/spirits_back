import { STATE_TTL_MS, signState, verifyState } from './youtube-state';

const SECRET = 'GOCSPX-test-secret';
const NOW = Date.parse('2026-10-27T12:00:00Z');

describe('state входа YouTube', () => {
  it('свой state в срок — чат владельца', () => {
    expect(verifyState(SECRET, signState(SECRET, 37948399, NOW), NOW + 60_000)).toEqual({ chatId: 37948399 });
  });

  it('срок вышел — null', () => {
    expect(verifyState(SECRET, signState(SECRET, 1, NOW), NOW + STATE_TTL_MS)).toBeNull();
  });

  it('подписан другим секретом — null', () => {
    expect(verifyState(SECRET, signState('другой', 1, NOW), NOW)).toBeNull();
  });

  it('подменённый чат при старой подписи — null', () => {
    const [, sig] = signState(SECRET, 1, NOW).split('.');
    const forged = Buffer.from(JSON.stringify({ c: 2, e: NOW + STATE_TTL_MS, n: 'x' })).toString('base64url');
    expect(verifyState(SECRET, `${forged}.${sig}`, NOW)).toBeNull();
  });

  it('мусор и пустой секрет — null, без исключений', () => {
    for (const bad of [undefined, '', 'abc', 'a.b.c', '.', 123]) expect(verifyState(SECRET, bad, NOW)).toBeNull();
    expect(verifyState('', signState(SECRET, 1, NOW), NOW)).toBeNull();
  });

  it('два state подряд различаются', () => {
    expect(signState(SECRET, 1, NOW)).not.toBe(signState(SECRET, 1, NOW));
  });
});
