import { encryptSecret, decryptSecret } from './crypto';
import { overlaps, CalendarService } from './calendar.service';

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

// Security regression (owner requirement): an agent must NEVER write to one user's calendar
// on behalf of another user. createEvent(userId) must resolve creds ONLY via that same userId's
// own row in calendar_connections — never a hardcoded id, never another user's connection.
describe('CalendarService.createEvent — write-scoping (no cross-user writes)', () => {
  it('is scoped to the passed userId and fails closed when that user has no connection', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new CalendarService(pg as any);

    const result = await service.createEvent('userB', { title: 'x', datetime: '2026-07-20T15:00:00' });

    // No connection for userB -> fail closed, no write attempted.
    expect(result).toEqual({ ok: false, error: 'Календарь не подключён' });
    // The lookup queried calendar_connections scoped to userB's own id — matches creds()'s
    // `SELECT ... FROM calendar_connections WHERE user_id=$1 AND enabled=true LIMIT 1`, [userId].
    expect(pg.query).toHaveBeenCalledWith(expect.stringContaining('calendar_connections'), ['userB']);
  });

  it("never reaches another user's (the owner's) connection while creating an event for userB", async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new CalendarService(pg as any);

    await service.createEvent('userB', { title: 'x', datetime: '2026-07-20T15:00:00' });

    // '79656445804' stands in for the owner's account (see CLAUDE.md test accounts). The only
    // WHERE-clause param used anywhere during this call must be the caller's own id ('userB') —
    // proving userB's write can never touch the owner's (or anyone else's) row.
    expect(pg.query).not.toHaveBeenCalledWith(expect.anything(), ['79656445804']);
    for (const call of pg.query.mock.calls) {
      expect(call[1]).toEqual(['userB']);
    }
  });
});
