import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

function makeService() {
  const pg = { query: jest.fn() };
  const versions = {
    getState: jest.fn(),
    createDraft: jest.fn(),
    publish: jest.fn(),
  };
  const service = new (AgentsService as any)(pg, versions);
  return { service, pg, versions };
}

describe('AgentsService.upsertAgent', () => {
  it('creates and publishes a draft before returning the fresh existing agent', async () => {
    const { service, pg, versions } = makeService();
    const current = { id: 12, name: 'roman', system_prompt: 'old', description: 'old' };
    const fresh = { ...current, system_prompt: 'new', description: 'new description' };
    const published = { id: 'published-1' };
    const latestDraft = { id: 'draft-base' };
    const createdDraft = { id: 'draft-new' };
    pg.query
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [fresh] });
    versions.getState.mockResolvedValue({ published, draft: latestDraft });
    versions.createDraft.mockResolvedValue(createdDraft);
    versions.publish.mockResolvedValue({ id: 'draft-new', status: 'published' });
    const data = {
      'agent-id': 12,
      name: 'roman',
      system_prompt: 'new',
      description: 'new description',
    };

    await expect(service.upsertAgent(data, 'admin-1')).resolves.toEqual(fresh);

    expect(versions.getState).toHaveBeenCalledWith(12);
    expect(versions.createDraft).toHaveBeenCalledWith('admin-1', 12, {
      description: 'new description',
      system_prompt: 'new',
      base_version_id: 'draft-base',
    });
    expect(versions.publish).toHaveBeenCalledWith('admin-1', 12, 'draft-new', 'published-1');
    expect(versions.createDraft.mock.invocationCallOrder[0]).toBeLessThan(
      versions.publish.mock.invocationCallOrder[0],
    );
    expect(pg.query.mock.calls.some(([sql]) => /UPDATE\s+agents/i.test(sql))).toBe(false);
  });

  it('uses the published version as the draft base when no draft exists', async () => {
    const { service, pg, versions } = makeService();
    pg.query
      .mockResolvedValueOnce({ rows: [{ id: 12, name: 'roman' }] })
      .mockResolvedValueOnce({ rows: [{ id: 12, name: 'roman', system_prompt: 'new' }] });
    versions.getState.mockResolvedValue({ published: { id: 'published-1' }, draft: null });
    versions.createDraft.mockResolvedValue({ id: 'draft-new' });
    versions.publish.mockResolvedValue({});

    await service.upsertAgent(
      { id: 12, system_prompt: 'new', description: 'description' },
      'admin-1',
    );

    expect(versions.createDraft).toHaveBeenCalledWith('admin-1', 12, {
      description: 'description',
      system_prompt: 'new',
      base_version_id: 'published-1',
    });
  });

  it('finds an existing agent by name when no id is supplied', async () => {
    const { service, pg, versions } = makeService();
    pg.query
      .mockResolvedValueOnce({ rows: [{ id: 12, name: 'roman' }] })
      .mockResolvedValueOnce({ rows: [{ id: 12, name: 'roman', system_prompt: 'new' }] });
    versions.getState.mockResolvedValue({ published: { id: 'published-1' }, draft: null });
    versions.createDraft.mockResolvedValue({ id: 'draft-new' });
    versions.publish.mockResolvedValue({});

    await service.upsertAgent(
      { name: 'roman', system_prompt: 'new', description: 'description' },
      'admin-1',
    );

    expect(pg.query.mock.calls[0][0]).toMatch(/FROM agents WHERE name = \$1/i);
    expect(pg.query.mock.calls[0][1]).toEqual(['roman']);
    expect(versions.createDraft).toHaveBeenCalledWith('admin-1', 12, expect.any(Object));
  });

  it('falls back to the existing name when the supplied id does not exist', async () => {
    const { service, pg, versions } = makeService();
    pg.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 12, name: 'roman' }] })
      .mockResolvedValueOnce({ rows: [{ id: 12, name: 'roman', system_prompt: 'new' }] });
    versions.getState.mockResolvedValue({ published: { id: 'published-1' }, draft: null });
    versions.createDraft.mockResolvedValue({ id: 'draft-new' });
    versions.publish.mockResolvedValue({});

    await service.upsertAgent(
      { id: 999, name: 'roman', system_prompt: 'new', description: 'description' },
      'admin-1',
    );

    expect(pg.query.mock.calls[1][0]).toMatch(/FROM agents WHERE name = \$1/i);
    expect(pg.query.mock.calls[1][1]).toEqual(['roman']);
    expect(versions.createDraft).toHaveBeenCalledWith('admin-1', 12, expect.any(Object));
  });

  it('inserts a new agent and its published v1 without draft or publish calls', async () => {
    const { service, pg, versions } = makeService();
    const agent = { id: 42, name: 'new-agent', system_prompt: 'prompt', description: 'description' };
    pg.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [agent] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(service.upsertAgent({
      'agent-id': 42,
      name: 'new-agent',
      system_prompt: 'prompt',
      description: 'description',
    }, 'admin-1')).resolves.toEqual(agent);

    expect(pg.query).toHaveBeenCalledTimes(4);
    const agentInsert = pg.query.mock.calls[2];
    expect(agentInsert[0]).toMatch(/INSERT INTO agents/i);
    expect(agentInsert[0]).toContain("COALESCE($4, nextval('agents_id_seq'))");
    expect(agentInsert[0]).toMatch(/RETURNING \*/i);
    expect(agentInsert[1]).toEqual(['new-agent', 'prompt', 'description', 42]);
    const versionInsert = pg.query.mock.calls[3];
    expect(versionInsert[0]).toMatch(/INSERT INTO agent_versions/i);
    expect(versionInsert[0]).toMatch(/'published'/i);
    expect(versionInsert[0]).toMatch(/published_at/i);
    expect(versionInsert[0]).toMatch(/published_by/i);
    expect(versionInsert[1]).toEqual([42, 'description', 'prompt', 'admin-1']);
    expect(versions.getState).not.toHaveBeenCalled();
    expect(versions.createDraft).not.toHaveBeenCalled();
    expect(versions.publish).not.toHaveBeenCalled();
    expect(pg.query.mock.calls.some(([sql]) => /UPDATE\s+agents/i.test(sql))).toBe(false);
  });
});

describe('AgentsController.upsertAgent', () => {
  it('passes the authenticated actor to the legacy service', async () => {
    const agents = { upsertAgent: jest.fn().mockResolvedValue({ id: 12 }) };
    const controller = new AgentsController(agents as any);
    const body = { id: 12, system_prompt: 'new' };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await controller.upsertAgent({ userId: 'admin-1' }, body, res);

    expect(agents.upsertAgent).toHaveBeenCalledWith(body, 'admin-1');
  });
});
