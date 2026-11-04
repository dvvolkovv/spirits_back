import { SupportService } from './support.service';

describe('просроченные тикеты поддержки', () => {
  it('считает точный COUNT без ограничения списка админки', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [{ n: 2 }] }) };
    const service = new SupportService(pg as any, null, null, null, null);

    await expect(service.countOverdueTickets()).resolves.toBe(2);

    expect(pg.query).toHaveBeenCalledTimes(1);
    const sql = pg.query.mock.calls[0][0] as string;
    expect(sql).toContain('SELECT count(*)::int AS n');
    expect(sql).toContain('first_owner_reply_at IS NULL');
    expect(sql).toContain('first_response_due_at < now()');
    expect(sql).toContain("status IN ('escalated','owner_handling')");
    expect(sql).not.toContain('LIMIT');
  });
});
