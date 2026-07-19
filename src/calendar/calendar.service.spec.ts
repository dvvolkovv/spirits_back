import { encryptSecret, decryptSecret } from './crypto';
import { overlaps } from './calendar.service';

describe('secret crypto', () => {
  beforeAll(() => { process.env.CALENDAR_SECRET_KEY = '0123456789abcdef0123456789abcdef'; });
  it('round-trips a secret and does not store plaintext', () => {
    const enc = encryptSecret('my-app-password');
    expect(enc).not.toContain('my-app-password');
    expect(decryptSecret(enc)).toBe('my-app-password');
  });
});

describe('overlaps', () => {
  const ev = (at: string, min = 60) => ({ at, end: new Date(new Date(at).getTime() + min * 60000).toISOString(), title: 't', source: 's' });
  it('true when proposed slot intersects an existing event', () => {
    expect(overlaps({ title: 'p', datetime: '2026-07-20T15:00:00' }, ev('2026-07-20T10:00:00Z'), 60)).toBe(true); // 15:00 YEKT == 10:00Z
  });
  it('false when clearly apart', () => {
    expect(overlaps({ title: 'p', datetime: '2026-07-20T20:00:00' }, ev('2026-07-20T10:00:00Z'), 60)).toBe(false);
  });
});
