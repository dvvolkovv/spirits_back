import { BadRequestException, ConflictException } from '@nestjs/common';
import { AgentVersionsService } from './agent-versions.service';

const live = {
  id: '11111111-1111-1111-1111-111111111111',
  agent_id: 12,
  version: 1,
  description: 'old',
  system_prompt: 'live',
  status: 'published',
  base_version_id: null,
  created_by: 'seed',
  created_at: '2026-10-31',
  published_at: '2026-10-31',
};

function makeService() {
  const query = jest.fn();
  const clientQuery = jest.fn();
  const release = jest.fn();
  const getClient = jest.fn().mockResolvedValue({ query: clientQuery, release });
  const service = new AgentVersionsService({ query, getClient } as any, {} as any);
  return { service, query, clientQuery, getClient, release };
}

const draftInput = {
  description: 'new',
  system_prompt: 'draft',
  base_version_id: live.id,
};

describe('AgentVersionsService', () => {
  it('creates the next draft from the latest version', async () => {
    const { service, query } = makeService();
    const inserted = {
      ...live,
      id: '22222222-2222-2222-2222-222222222222',
      version: 2,
      description: 'new',
      system_prompt: 'draft',
      status: 'draft',
      base_version_id: live.id,
      created_by: 'admin',
      created_at: new Date('2026-11-01T12:34:56.789Z'),
      published_at: null,
    };
    query
      .mockResolvedValueOnce({ rows: [live] })
      .mockResolvedValueOnce({ rows: [inserted] });

    const result = await service.createDraft('admin', 12, {
      ...draftInput,
      description: '  new  ',
      system_prompt: '  draft  ',
    });

    expect(result).toMatchObject({
      version: 2,
      status: 'draft',
      created_at: '2026-11-01T12:34:56.789Z',
    });
    expect(query.mock.calls[0][0]).toMatch(/ORDER BY version DESC/i);
    expect(query.mock.calls[0][1]).toEqual([12]);
    expect(query.mock.calls[1][1]).toEqual([
      12,
      'new',
      'draft',
      live.id,
      'admin',
      2,
    ]);
  });

  it('maps PostgreSQL Date timestamps from latest to ISO strings', async () => {
    const { service, query } = makeService();
    query.mockResolvedValueOnce({
      rows: [
        {
          ...live,
          created_at: new Date('2026-10-31T10:20:30.400Z'),
          published_at: new Date('2026-10-31T11:22:33.444Z'),
        },
      ],
    });

    const result = await service.latest(12);

    expect(result).toMatchObject({
      created_at: '2026-10-31T10:20:30.400Z',
      published_at: '2026-10-31T11:22:33.444Z',
    });
  });

  it.each([
    { case: 'there is no latest version', rows: [] },
    {
      case: 'the latest version has a different id',
      rows: [{ ...live, id: '33333333-3333-3333-3333-333333333333' }],
    },
  ])('rejects a stale base with 409 when $case and does not insert', async ({ rows }) => {
    const { service, query } = makeService();
    query.mockResolvedValueOnce({ rows });

    const error = await service
      .createDraft('admin', 12, draftInput)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      case: 'the prompt is empty',
      input: { ...draftInput, system_prompt: '   ' },
    },
    {
      case: 'the prompt exceeds 200000 characters',
      input: { ...draftInput, system_prompt: 'x'.repeat(200001) },
    },
    {
      case: 'the description exceeds 5000 characters',
      input: { ...draftInput, description: 'x'.repeat(5001) },
    },
  ])('rejects invalid input when $case', async ({ input }) => {
    const { service, query } = makeService();

    const error = await service
      .createDraft('admin', 12, input)
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { case: 'missing', value: undefined },
    { case: 'null', value: null },
    { case: 'numeric', value: 42 },
    { case: 'object', value: { prompt: 'draft' } },
  ])('rejects a $case system_prompt without inserting', async ({ value }) => {
    const { service, query } = makeService();
    const input: any = { ...draftInput };
    if (value === undefined) delete input.system_prompt;
    else input.system_prompt = value;

    const error = await service
      .createDraft('admin', 12, input)
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { case: 'missing', value: undefined },
    { case: 'null', value: null },
    { case: 'numeric', value: 42 },
    { case: 'object', value: { description: 'new' } },
  ])('normalizes a $case description to an empty string', async ({ value }) => {
    const { service, query } = makeService();
    const input: any = { ...draftInput };
    if (value === undefined) delete input.description;
    else input.description = value;
    query
      .mockResolvedValueOnce({ rows: [live] })
      .mockResolvedValueOnce({
        rows: [{ ...live, version: 2, status: 'draft', description: '' }],
      });

    await service.createDraft('admin', 12, input);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([
      12,
      '',
      'draft',
      live.id,
      'admin',
      2,
    ]);
  });

  it('maps a concurrent version insert to 409', async () => {
    const { service, query } = makeService();
    query
      .mockResolvedValueOnce({ rows: [live] })
      .mockRejectedValueOnce({
        code: '23505',
        constraint: 'agent_versions_agent_id_version_key',
      });

    const error = await service
      .createDraft('admin', 12, draftInput)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
  });

  it('runs migration, advisory lock and commit on one dedicated client', async () => {
    const { service, query, clientQuery, getClient, release } = makeService();
    clientQuery.mockResolvedValue({ rows: [] });

    await service.onModuleInit();

    expect(getClient).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(clientQuery).toHaveBeenCalledTimes(4);
    expect(clientQuery.mock.calls[0][0]).toBe('BEGIN');
    expect(clientQuery.mock.calls[1][0]).toBe(
      "SELECT pg_advisory_xact_lock(hashtext('agent_versions_008'))",
    );
    expect(clientQuery.mock.calls[2][0]).toContain(
      'CREATE TABLE IF NOT EXISTS agent_versions',
    );
    expect(clientQuery.mock.calls[3][0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('coalesces nullable agent fields during backfill', async () => {
    const { service, clientQuery } = makeService();
    clientQuery.mockResolvedValue({ rows: [] });

    await service.onModuleInit();

    const sql = clientQuery.mock.calls[2][0];
    expect(sql).toContain("COALESCE(description, '')");
    expect(sql).toContain("COALESCE(system_prompt, '')");
  });

  it('rolls back and releases the client when migration fails', async () => {
    const { service, clientQuery, release } = makeService();
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('migration failed'))
      .mockResolvedValueOnce({ rows: [] });

    const error = await service.onModuleInit().catch((e) => e);

    expect(error).toEqual(new Error('migration failed'));
    expect(clientQuery).toHaveBeenCalledTimes(4);
    expect(clientQuery.mock.calls[3][0]).toBe('ROLLBACK');
    expect(
      clientQuery.mock.calls.some(([sql]) => sql === 'COMMIT'),
    ).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('gets a version by both id and agent id', async () => {
    const { service, query } = makeService();
    query.mockResolvedValueOnce({ rows: [live] });

    const result = await service.getVersion(12, live.id);

    expect(result.id).toBe(live.id);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(
      /WHERE id = \$1 AND agent_id = \$2/i,
    );
    expect(query.mock.calls[0][1]).toEqual([live.id, 12]);
  });

  it('returns 404 when the version does not belong to the agent', async () => {
    const { service, query } = makeService();
    query.mockResolvedValueOnce({ rows: [] });

    const error = await service.getVersion(12, live.id).catch((e) => e);

    expect(error.getStatus()).toBe(404);
    expect(query.mock.calls[0][1]).toEqual([live.id, 12]);
  });

  it.each([
    { limit: undefined, expected: 50 },
    { limit: 0, expected: 1 },
    { limit: 500, expected: 50 },
  ])('lists newest versions with limit $limit clamped to $expected', async ({
    limit,
    expected,
  }) => {
    const { service, query } = makeService();
    query.mockResolvedValueOnce({
      rows: [{ ...live, version: 3 }, { ...live, version: 2 }],
    });

    const result = await service.listVersions(12, limit);

    expect(result.map((version) => version.version)).toEqual([3, 2]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/ORDER BY version DESC/i);
    expect(query.mock.calls[0][0]).toMatch(/LIMIT \$2/i);
    expect(query.mock.calls[0][1]).toEqual([12, expected]);
  });

  it('gets one state snapshot with more than 50 newer drafts', async () => {
    const { service, query } = makeService();
    const newestDraft = {
      ...live,
      id: '22222222-2222-2222-2222-222222222222',
      version: 60,
      status: 'draft',
      published_at: null,
    };
    query.mockResolvedValueOnce({
      rows: [{ published: live, draft: newestDraft }],
    });

    const state = await service.getState(12);

    expect(state.published).toMatchObject({ id: live.id, status: 'published' });
    expect(state.draft).toMatchObject({ id: newestDraft.id, version: 60 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/row_to_json/i);
    expect(query.mock.calls[0][0]).toMatch(/status = 'published'/i);
    expect(query.mock.calls[0][0]).toMatch(/status = 'draft'/i);
    expect(query.mock.calls[0][0]).toMatch(/ORDER BY version DESC/i);
    expect(query.mock.calls[0][0]).toMatch(/LIMIT 1/i);
    expect(query.mock.calls[0][1]).toEqual([12]);
  });

  it('publishes a draft atomically and updates the live agent', async () => {
    const { service, query, clientQuery, getClient, release } = makeService();
    const draft = {
      ...live,
      id: '22222222-2222-2222-2222-222222222222',
      version: 2,
      description: 'new description',
      system_prompt: 'new prompt',
      status: 'draft',
      base_version_id: live.id,
      published_at: null,
      published_by: null,
    };
    const published = {
      ...draft,
      status: 'published',
      published_at: new Date('2026-11-01T12:00:00.000Z'),
      published_by: 'editor',
    };
    query.mockResolvedValueOnce({ rows: [draft] });
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 12 }] })
      .mockResolvedValueOnce({ rows: [live] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [published] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.publish('editor', 12, draft.id, live.id);

    expect(result).toMatchObject({
      id: draft.id,
      status: 'published',
      published_at: '2026-11-01T12:00:00.000Z',
      published_by: 'editor',
    });
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(clientQuery).toHaveBeenCalledTimes(7);
    expect(clientQuery.mock.calls[0][0]).toBe('BEGIN');
    expect(clientQuery.mock.calls[1][0]).toMatch(/SELECT id FROM agents/i);
    expect(clientQuery.mock.calls[1][0]).toMatch(/FOR UPDATE/i);
    expect(clientQuery.mock.calls[1][1]).toEqual([12]);
    expect(clientQuery.mock.calls[2][0]).toMatch(/status = 'published'/i);
    expect(clientQuery.mock.calls[2][0]).toMatch(/FOR UPDATE/i);
    expect(clientQuery.mock.calls[2][1]).toEqual([12]);
    expect(clientQuery.mock.calls[3][0]).toMatch(/status = 'superseded'/i);
    expect(clientQuery.mock.calls[3][1]).toEqual([live.id, 12]);
    expect(clientQuery.mock.calls[4][0]).toMatch(/status = 'published'/i);
    expect(clientQuery.mock.calls[4][0]).toMatch(/published_at = now\(\)/i);
    expect(clientQuery.mock.calls[4][0]).toMatch(/published_by = \$1/i);
    expect(clientQuery.mock.calls[4][1]).toEqual(['editor', draft.id, 12]);
    expect(clientQuery.mock.calls[5][0]).toMatch(/UPDATE agents/i);
    expect(clientQuery.mock.calls[5][1]).toEqual([
      'new description',
      'new prompt',
      12,
    ]);
    expect(clientQuery.mock.calls[6][0]).toBe('COMMIT');
    expect(
      clientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK'),
    ).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith();
  });

  it('rejects a stale expected published id without updating rows', async () => {
    const { service, query, clientQuery, release } = makeService();
    const draft = {
      ...live,
      id: '22222222-2222-2222-2222-222222222222',
      status: 'draft',
    };
    query.mockResolvedValueOnce({ rows: [draft] });
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 12 }] })
      .mockResolvedValueOnce({ rows: [live] })
      .mockResolvedValueOnce({ rows: [] });

    const error = await service
      .publish('editor', 12, draft.id, 'stale-live-id')
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(clientQuery).toHaveBeenCalledTimes(4);
    expect(clientQuery.mock.calls[0][0]).toBe('BEGIN');
    expect(clientQuery.mock.calls[1][0]).toMatch(/SELECT id FROM agents/i);
    expect(clientQuery.mock.calls[3][0]).toBe('ROLLBACK');
    expect(
      clientQuery.mock.calls.some(([sql]) => /^UPDATE/i.test(sql)),
    ).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith();
  });

  it('destroys the client when rollback fails without masking the SQL error', async () => {
    const { service, query, clientQuery, release } = makeService();
    const draft = {
      ...live,
      id: '22222222-2222-2222-2222-222222222222',
      status: 'draft',
      description: 'new description',
      system_prompt: 'new prompt',
    };
    const failure = new Error('agent update failed');
    query.mockResolvedValueOnce({ rows: [draft] });
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 12 }] })
      .mockResolvedValueOnce({ rows: [live] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...draft, status: 'published' }] })
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new Error('rollback failed'));

    await expect(
      service.publish('editor', 12, draft.id, live.id),
    ).rejects.toBe(failure);

    expect(clientQuery).toHaveBeenCalledTimes(7);
    expect(clientQuery.mock.calls[6][0]).toBe('ROLLBACK');
    expect(
      clientQuery.mock.calls.some(([sql]) => sql === 'COMMIT'),
    ).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
  });

  it('rolls back and returns 404 when the parent agent is missing', async () => {
    const { service, query, clientQuery, release } = makeService();
    const draft = {
      ...live,
      id: '22222222-2222-2222-2222-222222222222',
      status: 'draft',
    };
    query.mockResolvedValueOnce({ rows: [draft] });
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const error = await service
      .publish('editor', 12, draft.id, live.id)
      .catch((e) => e);

    expect(error.getStatus()).toBe(404);
    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(clientQuery.mock.calls[2][0]).toBe('ROLLBACK');
    expect(
      clientQuery.mock.calls.some(([sql]) => /^UPDATE/i.test(sql)),
    ).toBe(false);
    expect(release).toHaveBeenCalledWith();
  });

  it('rejects a non-draft publish before opening a client', async () => {
    const { service, query, getClient } = makeService();
    query.mockResolvedValueOnce({ rows: [live] });

    const error = await service
      .publish('editor', 12, live.id, live.id)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(query).toHaveBeenCalledTimes(1);
    expect(getClient).not.toHaveBeenCalled();
  });
});
