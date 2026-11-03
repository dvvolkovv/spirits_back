import { firstResponseDueAt, SLA_SOON_MS, slaFilterSql, SlaFilter } from './support-sla';
import { SupportService } from './support.service';

describe('support SLA', () => {
  const escalationMs = Date.parse('2026-01-01T00:00:00.000Z');

  it.each([
    ['critical', 15 * 60_000],
    ['high', 60 * 60_000],
    ['normal', 4 * 60 * 60_000],
    ['low', 24 * 60 * 60_000],
  ])('uses the %s first-response duration', (urgency, duration) => {
    expect(firstResponseDueAt(urgency, escalationMs)).toBe(escalationMs + duration);
  });

  it('uses the normal duration for NULL urgency', () => {
    expect(firstResponseDueAt(null, escalationMs)).toBe(escalationMs + 4 * 60 * 60_000);
  });

  it('uses the normal duration for unknown urgency', () => {
    expect(firstResponseDueAt('unexpected', escalationMs)).toBe(escalationMs + 4 * 60 * 60_000);
  });

  it('defines the soon threshold as 30 minutes', () => {
    expect(SLA_SOON_MS).toBe(30 * 60_000);
  });

  it.each([
    ['overdue', 'first_owner_reply_at IS NULL AND first_response_due_at < now()', []],
    ['soon', "first_owner_reply_at IS NULL AND first_response_due_at >= now() AND first_response_due_at <= now() + interval '30 minutes'", []],
    ['unassigned', 'assigned_to IS NULL', []],
    ['mine', 'assigned_to = $SLA_ACTOR$', ['owner-1']],
  ] as Array<[SlaFilter, string, any[]]>)('builds the %s filter', (filter, sql, params) => {
    expect(slaFilterSql(filter, 'owner-1')).toEqual({ sql, params });
  });

  it('does not restrict tickets when no SLA filter is selected', () => {
    expect(slaFilterSql(undefined, 'owner-1')).toEqual({ sql: 'TRUE', params: [] });
  });
});

describe('SupportService migrations', () => {
  it('applies both migrations on one client in a transaction under an advisory lock', async () => {
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pg = {
      getClient: jest.fn(async () => client),
      query: jest.fn(),
    };

    await new SupportService(pg as any).onModuleInit();

    expect(pg.getClient).toHaveBeenCalledTimes(1);
    expect(pg.query).not.toHaveBeenCalled();
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toContain('pg_advisory_xact_lock');
    expect(queries.some((sql) => sql.includes('001_support.sql'))).toBe(true);
    expect(queries.some((sql) => sql.includes('002_support_sla.sql'))).toBe(true);
    expect(queries[queries.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and rethrows the original error when the second migration fails', async () => {
    const original = new Error('second migration failed');
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('002_support_sla.sql')) throw original;
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pg = { getClient: jest.fn(async () => client) };
    const service = new SupportService(pg as any);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

    let rejection: unknown;
    try {
      await service.onModuleInit();
    } catch (e) {
      rejection = e;
    }

    expect(rejection).toBe(original);
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
