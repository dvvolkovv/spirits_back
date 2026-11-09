import { maskRetentionEmail, RetentionUnsubscribeService } from './retention-unsubscribe.service';

const SECRET = '33'.repeat(32);
const ORIGINAL_SECRET = process.env.RETENTION_UNSUBSCRIBE_SECRET;

describe('RetentionUnsubscribeService', () => {
  const pg = { query: jest.fn() };
  let svc: RetentionUnsubscribeService;

  beforeEach(() => {
    process.env.RETENTION_UNSUBSCRIBE_SECRET = SECRET;
    pg.query.mockReset();
    pg.query.mockResolvedValue({
      rows: [{ token: 'r'.repeat(43), email: 'user@example.com', unsubscribed_at: null }],
    });
    svc = new RetentionUnsubscribeService(pg as any);
  });

  afterAll(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.RETENTION_UNSUBSCRIBE_SECRET;
    else process.env.RETENTION_UNSUBSCRIBE_SECRET = ORIGINAL_SECRET;
  });

  it('ensureToken не обращается к pg и не раскрывает plaintext email', async () => {
    const token = await svc.ensureToken('User@Example.com');
    expect(pg.query).not.toHaveBeenCalled();
    expect(token).not.toContain('User@Example.com');
    expect(token).not.toContain('user@example.com');
  });

  it('два токена различаются, но оба разрешают один нормализованный email', async () => {
    const first = await svc.ensureToken('User@Example.com');
    const second = await svc.ensureToken('user@example.com');
    expect(first).not.toBe(second);
    pg.query.mockClear();
    pg.query.mockResolvedValue({ rows: [] });
    await expect(svc.findByToken(first)).resolves.toEqual({
      email: 'user@example.com', unsubscribedAt: null,
    });
    await expect(svc.findByToken(second)).resolves.toEqual({
      email: 'user@example.com', unsubscribedAt: null,
    });
    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(pg.query.mock.calls[0][1]).toEqual(['user@example.com']);
    expect(pg.query.mock.calls[1][1]).toEqual(['user@example.com']);
    expect(pg.query.mock.calls[0][0]).toContain('WHERE email_normalized=$1');
  });

  it('malformed и tampered токены возвращают null без suppression query', async () => {
    const token = await svc.ensureToken('person@example.com');
    const tamperedBytes = Buffer.from(token, 'base64url');
    tamperedBytes[tamperedBytes.length - 1] ^= 1;
    const tampered = tamperedBytes.toString('base64url');
    pg.query.mockClear();
    await expect(svc.findByToken('../secret')).resolves.toBeNull();
    await expect(svc.findByToken(tampered)).resolves.toBeNull();
    await expect(svc.unsubscribe(tampered)).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('отписка делает UPSERT по email и сохраняет первое время', async () => {
    const token = await svc.ensureToken(' User@Example.com ');
    const at = new Date('2026-11-08T10:00:00Z');
    pg.query.mockClear();
    pg.query.mockResolvedValueOnce({
      rows: [{ email: 'user@example.com', unsubscribed_at: at }],
    });
    const result = await svc.unsubscribe(token);
    expect(result).toEqual({ email: 'user@example.com', unsubscribedAt: at });
    expect(pg.query.mock.calls[0][1]).toEqual(['user@example.com', token]);
    expect(pg.query.mock.calls[0][0]).toContain('ON CONFLICT (email_normalized) DO UPDATE');
    expect(pg.query.mock.calls[0][0]).toContain(
      'COALESCE(retention_email_unsubscribes.unsubscribed_at,now())',
    );
  });

  it('suppression проверяется по нормализованному адресу', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(svc.isUnsubscribed(' User@Example.com ')).resolves.toBe(true);
    expect(pg.query.mock.calls[0][1]).toEqual(['user@example.com']);
  });

  it('найденная, но неудачная SQL-миграция отклоняет onModuleInit', async () => {
    pg.query.mockRejectedValueOnce(new Error('boom'));
    jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);
    await expect(svc.onModuleInit()).rejects.toThrow('was found but did not apply');
  });

  it('маскирует по кодовым точкам, включая оба двухточечных случая', () => {
    expect(maskRetentionEmail('person@example.com')).toBe('p***n@example.com');
    expect(maskRetentionEmail('ab@example.com')).toBe('a***@example.com');
    expect(maskRetentionEmail('😀@example.com')).toBe('😀***@example.com');
    expect(maskRetentionEmail('a😀@example.com')).toBe('a***@example.com');
    expect(maskRetentionEmail('😀😀@example.com')).toBe('😀***@example.com');
  });
});
