import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SupportService } from './support.service';

const TICKET_ID = 'ticket-1';
const ACTOR_ID = 'owner-actor';
const EXPECTED_UPDATED_AT = '2026-01-01T00:00:00.000Z';

function makeWorld(opts: { failRollback?: boolean; failUpdate?: Error } = {}) {
  const ticket = {
    id: TICKET_ID,
    user_id: 'user-1',
    status: 'escalated',
    assigned_to: null as string | null,
    assigned_at: null as Date | null,
    updated_at: new Date(EXPECTED_UPDATED_AT),
  };
  const events: any[] = [];
  const calls: Array<{ sql: string; params: any[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (normalized === 'ROLLBACK' && opts.failRollback) throw new Error('rollback failed');
      if (/FROM support_tickets WHERE id = \$1 FOR UPDATE/.test(normalized)) {
        return { rows: [{ ...ticket }] };
      }
      if (/FROM ai_profiles_consolidated/.test(normalized)) {
        return { rows: [{ user_id: 'admin-1', name: 'Admin One' }] };
      }
      if (/UPDATE support_tickets/.test(normalized)) {
        if (opts.failUpdate) throw opts.failUpdate;
        ticket.assigned_to = params[0];
        ticket.assigned_at = params[0] === null ? null : new Date('2026-01-02T00:00:00.000Z');
        ticket.status = params[1];
        ticket.updated_at = new Date('2026-01-02T00:00:00.000Z');
        return { rows: [{ ...ticket }] };
      }
      if (/INSERT INTO support_events/.test(normalized)) {
        events.push({ ticket_id: params[0], actor_type: 'owner', actor_id: params[1], payload: JSON.parse(params[2]) });
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pg = {
    query: jest.fn(async (sql: string, params?: any[]) => ({
      rows: [
        { user_id: 'admin-a', name: 'Alice' },
        { user_id: 'admin-b', name: 'Bob' },
      ],
    })),
    getClient: jest.fn(async () => client),
  };
  const service = new SupportService(pg as any);
  return { service, pg, client, ticket, events, calls };
}

describe('support assignment', () => {
  it('lists active admin operators with the shared operators query', async () => {
    const w = makeWorld();

    await expect(w.service.adminOperators()).resolves.toEqual([
      { id: 'admin-a', name: 'Alice' },
      { id: 'admin-b', name: 'Bob' },
    ]);

    const sql = w.pg.query.mock.calls[0][0].replace(/\s+/g, ' ');
    expect(sql).toContain("COALESCE(p.profile_data->>'name', p.profile_data->>'first_name', p.user_id) AS name");
    expect(sql).toContain("JOIN user_id u ON u.internal_id = p.user_id AND u.state <> 'deleted'");
    expect(sql).toContain('WHERE p.isadmin = true ORDER BY name');
  });

  it('assigns an active admin, records the event, and commits on the dedicated client', async () => {
    const w = makeWorld();

    const result = await w.service.assign(ACTOR_ID, TICKET_ID, {
      assigneeId: 'admin-1', expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });

    expect(result).toMatchObject({ assigned_to: 'admin-1', status: 'owner_handling' });
    expect(result.assigned_at).toBeInstanceOf(Date);
    expect(w.events).toEqual([{
      ticket_id: TICKET_ID,
      actor_type: 'owner',
      actor_id: ACTOR_ID,
      payload: { from: null, to: 'admin-1' },
    }]);
    expect(w.calls.map((c) => c.sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(w.calls.some((c) => c.sql === 'ROLLBACK')).toBe(false);
    expect(w.calls.every((c) => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(c.sql) || c.params.length === 0)).toBe(true);
    expect(w.client.release).toHaveBeenCalledWith();
  });

  it('rejects a stale expectedUpdatedAt with 409 and does not overwrite the ticket', async () => {
    const w = makeWorld();

    await expect(w.service.assign(ACTOR_ID, TICKET_ID, {
      assigneeId: 'admin-1', expectedUpdatedAt: '2025-12-31T23:59:59.000Z',
    })).rejects.toBeInstanceOf(ConflictException);

    expect(w.ticket.assigned_to).toBeNull();
    expect(w.events).toHaveLength(0);
    expect(w.calls.some((c) => /UPDATE support_tickets|INSERT INTO support_events/.test(c.sql))).toBe(false);
    expect(w.calls.some((c) => c.sql === 'COMMIT')).toBe(false);
    expect(w.calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
  });

  it('unassigns without checking operators and returns the ticket to escalated', async () => {
    const w = makeWorld();
    w.ticket.assigned_to = 'admin-old';
    w.ticket.assigned_at = new Date('2026-01-01T01:00:00.000Z');
    w.ticket.status = 'owner_handling';

    const result = await w.service.assign(ACTOR_ID, TICKET_ID, {
      assigneeId: null, expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });

    expect(result).toMatchObject({ assigned_to: null, assigned_at: null, status: 'escalated' });
    expect(w.calls.some((c) => /FROM ai_profiles_consolidated/.test(c.sql))).toBe(false);
    expect(w.events[0].payload).toEqual({ from: 'admin-old', to: null });
    expect(w.calls.some((c) => c.sql === 'COMMIT')).toBe(true);
  });

  it('rejects a non-admin assignee before any write', async () => {
    const w = makeWorld();

    await expect(w.service.assign(ACTOR_ID, TICKET_ID, {
      assigneeId: 'not-an-admin', expectedUpdatedAt: EXPECTED_UPDATED_AT,
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(w.calls.some((c) => /UPDATE support_tickets|INSERT INTO support_events/.test(c.sql))).toBe(false);
    expect(w.events).toHaveLength(0);
    expect(w.calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
    expect(w.calls.some((c) => c.sql === 'COMMIT')).toBe(false);
  });

  it.each(['', '   '])('requires a non-empty expectedUpdatedAt before acquiring a client', async (value) => {
    const w = makeWorld();

    await expect(w.service.assign(ACTOR_ID, TICKET_ID, {
      assigneeId: null, expectedUpdatedAt: value,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(w.pg.getClient).not.toHaveBeenCalled();
  });

  it.each([123, { value: EXPECTED_UPDATED_AT }, null])(
    'rejects non-string expectedUpdatedAt %# without touching the database', async (value) => {
      const w = makeWorld();

      await expect(w.service.assign(ACTOR_ID, TICKET_ID, {
        assigneeId: null, expectedUpdatedAt: value as any,
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(w.pg.getClient).not.toHaveBeenCalled();
      expect(w.calls).toHaveLength(0);
    },
  );

  it('rejects a malformed expectedUpdatedAt without touching the database', async () => {
    const w = makeWorld();

    await expect(w.service.assign(ACTOR_ID, TICKET_ID, {
      assigneeId: null, expectedUpdatedAt: 'not-a-date',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(w.pg.getClient).not.toHaveBeenCalled();
    expect(w.calls).toHaveLength(0);
  });

  it('rejects a null DTO without touching the database', async () => {
    const w = makeWorld();

    await expect(w.service.assign(ACTOR_ID, TICKET_ID, null as any))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(w.pg.getClient).not.toHaveBeenCalled();
    expect(w.calls).toHaveLength(0);
  });

  it('returns 404 for a missing ticket', async () => {
    const w = makeWorld();
    w.client.query.mockImplementation(async (sql: string) => ({
      rows: /FOR UPDATE/.test(sql) ? [] : [],
    }));

    await expect(w.service.assign(ACTOR_ID, TICKET_ID, {
      assigneeId: null, expectedUpdatedAt: EXPECTED_UPDATED_AT,
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(w.calls.some((c) => c.sql === 'COMMIT')).toBe(false);
  });

  it('preserves the original error and destroys the client when rollback fails', async () => {
    const original = new Error('update failed');
    const w = makeWorld({ failRollback: true, failUpdate: original });

    await expect(w.service.assign(ACTOR_ID, TICKET_ID, {
      assigneeId: 'admin-1', expectedUpdatedAt: EXPECTED_UPDATED_AT,
    })).rejects.toBe(original);
    expect(w.client.release).toHaveBeenCalledWith(true);
  });
});
