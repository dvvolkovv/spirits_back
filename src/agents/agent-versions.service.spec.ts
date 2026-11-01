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
  const service = new AgentVersionsService({ query } as any, {} as any);
  return { service, query };
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

    expect(result).toMatchObject({ version: 2, status: 'draft' });
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

  it('applies the agent versions migration on module init', async () => {
    const { service, query } = makeService();
    query.mockResolvedValueOnce({ rows: [] });

    await service.onModuleInit();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain(
      'CREATE TABLE IF NOT EXISTS agent_versions',
    );
  });
});
