import { STATE_TTL_MS, signState, verifyState } from './youtube-state';

const SECRET = 'GOCSPX-test-secret';
const TEST = 'https://test.linkeon.io/webhook/shorts/youtube/oauth/callback';
const PROD = 'https://my.linkeon.io/webhook/shorts/youtube/oauth/callback';
const NOW = Date.parse('2026-10-27T12:00:00Z');

describe('state входа YouTube', () => {
  it('свой state в срок — чат владельца', () => {
    expect(verifyState(SECRET, TEST, signState(SECRET, TEST, 37948399, NOW), NOW + 60_000)).toEqual({ chatId: 37948399 });
  });

  it('срок вышел — null', () => {
    expect(verifyState(SECRET, TEST, signState(SECRET, TEST, 1, NOW), NOW + STATE_TTL_MS)).toBeNull();
  });

  it('подписан другим секретом — null', () => {
    expect(verifyState(SECRET, TEST, signState('другой', TEST, 1, NOW), NOW)).toBeNull();
  });

  it('state стенда не годится проду: адрес возврата входит в ключ', () => {
    expect(verifyState(SECRET, PROD, signState(SECRET, TEST, 1, NOW), NOW)).toBeNull();
  });

  it('подменённый чат при старой подписи — null', () => {
    const [, sig] = signState(SECRET, TEST, 1, NOW).split('.');
    const forged = Buffer.from(JSON.stringify({ c: 2, e: NOW + STATE_TTL_MS, n: 'x' })).toString('base64url');
    expect(verifyState(SECRET, TEST, `${forged}.${sig}`, NOW)).toBeNull();
  });

  it('мусор, пустой секрет и пустой адрес — null, без исключений', () => {
    for (const bad of [undefined, '', 'abc', 'a.b.c', '.', 123]) expect(verifyState(SECRET, TEST, bad, NOW)).toBeNull();
    expect(verifyState('', TEST, signState(SECRET, TEST, 1, NOW), NOW)).toBeNull();
    expect(verifyState(SECRET, '', signState(SECRET, TEST, 1, NOW), NOW)).toBeNull();
  });

  it('два state подряд различаются', () => {
    expect(signState(SECRET, TEST, 1, NOW)).not.toBe(signState(SECRET, TEST, 1, NOW));
  });
});
