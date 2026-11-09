import { maskRetentionEmail, RetentionUnsubscribeService } from './retention-unsubscribe.service';

describe('RetentionUnsubscribeService', () => {
  const pg = { query: jest.fn() };
  let svc: RetentionUnsubscribeService;

  beforeEach(() => {
    pg.query.mockReset();
    svc = new RetentionUnsubscribeService(pg as any);
  });

  it('возвращает новый токен после вставки', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ token: 'a'.repeat(43) }] });
    await expect(svc.ensureToken('User@Example.com')).resolves.toBe('a'.repeat(43));
    expect(pg.query.mock.calls[0][1][0]).toBe('user@example.com');
    expect(pg.query.mock.calls[0][1][1]).toHaveLength(43);
  });

  it('при конфликте читает существующий стабильный токен', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ token: 'b'.repeat(43) }] });
    await expect(svc.ensureToken('user@example.com')).resolves.toBe('b'.repeat(43));
    expect(pg.query).toHaveBeenCalledTimes(2);
  });

  it('не ищет заведомо невалидный токен', async () => {
    await expect(svc.findByToken('../secret')).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('отписка сохраняет первое время через COALESCE', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ email: 'u@example.com', unsubscribed_at: new Date('2026-11-08T10:00:00Z') }] });
    const result = await svc.unsubscribe('x'.repeat(43));
    expect(result?.email).toBe('u@example.com');
    expect(pg.query.mock.calls[0][0]).toContain('COALESCE(unsubscribed_at, now())');
  });

  it('suppression проверяется по нормализованному адресу', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(svc.isUnsubscribed(' User@Example.com ')).resolves.toBe(true);
    expect(pg.query.mock.calls[0][1]).toEqual(['user@example.com']);
  });

  it('маскирует адрес на публичной странице', () => {
    expect(maskRetentionEmail('person@example.com')).toBe('p***n@example.com');
    expect(maskRetentionEmail('ab@example.com')).toBe('a***@example.com');
    expect(maskRetentionEmail('😀@example.com')).toBe('😀***@example.com');
    expect(maskRetentionEmail('a😀@example.com')).toBe('a***😀@example.com');
  });
});
