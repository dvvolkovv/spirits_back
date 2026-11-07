import axios from 'axios';
import { ProfileCompactionService } from './profile-compaction.service';
import { automaticProfilingAllowed } from '../privacy/profile-privacy';

jest.mock('../privacy/profile-privacy', () => ({
  automaticProfilingAllowed: jest.fn(),
}));

const automaticProfilingAllowedMock = automaticProfilingAllowed as jest.MockedFunction<
  typeof automaticProfilingAllowed
>;

function makeService() {
  const pg = {
    query: jest.fn(async (_sql: string, _params?: any[]): Promise<any> => ({ rows: [] })),
  };
  const neo4j = {
    listEntitiesForCompaction: jest.fn(async (): Promise<any[]> => []),
    dropEntityRelation: jest.fn(async () => {}),
    mergeEntitiesInProfile: jest.fn(async () => {}),
  };
  const claudeCli = { text: jest.fn(async (): Promise<string | null> => null) };
  const svc = new ProfileCompactionService(pg as any, neo4j as any, claudeCli as any);
  return { svc, pg, neo4j, claudeCli };
}

function entity(key: string, support = 1) {
  return {
    canonicalKey: key,
    name: key,
    aliases: [],
    support,
    updatedAt: new Date().toISOString(),
  };
}

function trustedEntities(count: number) {
  return Array.from({ length: count }, (_, i) => entity(`entity-${i}`, 20));
}

describe('ProfileCompactionService automatic profiling privacy gates', () => {
  let previousOpenRouterKey: string | undefined;

  beforeEach(() => {
    automaticProfilingAllowedMock.mockReset().mockResolvedValue(true);
    previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'privacy-spec-key';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousOpenRouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
    }
  });

  it('does not read entities or chat history when compactUser is disabled', async () => {
    automaticProfilingAllowedMock.mockResolvedValue(false);
    const { svc, pg, neo4j } = makeService();

    await expect(svc.compactUser('u1')).resolves.toEqual({ skipped: 'privacy' });

    expect(neo4j.listEntitiesForCompaction).not.toHaveBeenCalled();
    expect(neo4j.dropEntityRelation).not.toHaveBeenCalled();
    expect(neo4j.mergeEntitiesInProfile).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('stops before dropEntityRelation when consent is revoked by the history read', async () => {
    let revoked = false;
    automaticProfilingAllowedMock.mockImplementation(async () => !revoked);
    const { svc, pg, neo4j } = makeService();
    neo4j.listEntitiesForCompaction.mockResolvedValue([entity('private-fact')]);
    pg.query.mockImplementation(async () => {
      revoked = true;
      return { rows: [] };
    });

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ userId: 'u1', skipped: 'privacy' });
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(neo4j.dropEntityRelation).not.toHaveBeenCalled();
    expect(neo4j.mergeEntitiesInProfile).not.toHaveBeenCalled();
  });

  it('does not run validation LLM when consent is revoked during history read', async () => {
    let revoked = false;
    automaticProfilingAllowedMock.mockImplementation(async () => !revoked);
    const { svc, pg, neo4j } = makeService();
    neo4j.listEntitiesForCompaction.mockResolvedValue([entity('private-fact')]);
    pg.query.mockImplementation(async () => {
      revoked = true;
      return { rows: [{ content: 'private fact from the user' }] };
    });
    const validate = jest.spyOn(svc as any, 'llmValidateEntity').mockResolvedValue(true);

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ skipped: 'privacy' });
    expect(validate).not.toHaveBeenCalled();
    expect(neo4j.listEntitiesForCompaction).toHaveBeenCalledTimes(1);
  });

  it('checks each suspect before history so a revoked first entity does not lead to the next read', async () => {
    let revoked = false;
    automaticProfilingAllowedMock.mockImplementation(async () => !revoked);
    const { svc, neo4j } = makeService();
    neo4j.listEntitiesForCompaction.mockResolvedValue([entity('first'), entity('second')]);
    const matches = jest.spyOn(svc as any, 'findUserMatches').mockResolvedValue(['matching text']);
    jest.spyOn(svc as any, 'llmValidateEntity').mockImplementation(async () => {
      revoked = true;
      return null;
    });

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ skipped: 'privacy' });
    expect(matches).toHaveBeenCalledTimes(1);
  });

  it('stops after an empty category instead of reading the next category after revocation', async () => {
    let revoked = false;
    automaticProfilingAllowedMock.mockImplementation(async () => !revoked);
    const { svc, neo4j } = makeService();
    neo4j.listEntitiesForCompaction.mockImplementation(async () => {
      revoked = true;
      return [];
    });

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ skipped: 'privacy' });
    expect(neo4j.listEntitiesForCompaction).toHaveBeenCalledTimes(1);
  });

  it('stops immediately after the remaining read without fetching afterPrune', async () => {
    let revoked = false;
    let reads = 0;
    automaticProfilingAllowedMock.mockImplementation(async () => !revoked);
    const { svc, neo4j } = makeService();
    neo4j.listEntitiesForCompaction.mockImplementation(async () => {
      reads++;
      if (reads === 2) revoked = true;
      return trustedEntities(1);
    });

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ skipped: 'privacy' });
    expect(neo4j.listEntitiesForCompaction).toHaveBeenCalledTimes(2);
  });

  it('does not call merge grouping when consent is revoked by the afterPrune read', async () => {
    let revoked = false;
    let reads = 0;
    automaticProfilingAllowedMock.mockImplementation(async () => !revoked);
    const { svc, neo4j } = makeService();
    neo4j.listEntitiesForCompaction.mockImplementation(async () => {
      reads++;
      if (reads === 3) revoked = true;
      return trustedEntities(12);
    });
    const group = jest.spyOn(svc as any, 'llmGroupSynonyms').mockResolvedValue([]);

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ skipped: 'privacy' });
    expect(group).not.toHaveBeenCalled();
    expect(neo4j.mergeEntitiesInProfile).not.toHaveBeenCalled();
  });

  it('checks before finalList for a small category with no merge pass', async () => {
    automaticProfilingAllowedMock.mockImplementation(
      async () => automaticProfilingAllowedMock.mock.calls.length < 6,
    );
    const { svc, neo4j } = makeService();
    neo4j.listEntitiesForCompaction.mockResolvedValue(trustedEntities(1));

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ skipped: 'privacy' });
    expect(neo4j.listEntitiesForCompaction).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['empty groups', []],
    ['singleton groups', [{ canonical: 'entity-0', merge_from: ['entity-0'] }]],
  ])('checks before finalList after %s', async (_name, groups) => {
    let revoked = false;
    automaticProfilingAllowedMock.mockImplementation(async () => !revoked);
    const { svc, neo4j } = makeService();
    neo4j.listEntitiesForCompaction.mockResolvedValue(trustedEntities(12));
    jest.spyOn(svc as any, 'llmGroupSynonyms').mockImplementation(async () => {
      revoked = true;
      return groups;
    });

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ skipped: 'privacy' });
    expect(neo4j.listEntitiesForCompaction).toHaveBeenCalledTimes(3);
    expect(neo4j.mergeEntitiesInProfile).not.toHaveBeenCalled();
  });

  it('does not call validation OpenRouter fallback when Claude returns null after revocation', async () => {
    let revoked = false;
    automaticProfilingAllowedMock.mockImplementation(async () => !revoked);
    const { svc, neo4j, claudeCli } = makeService();
    neo4j.listEntitiesForCompaction.mockResolvedValue([entity('private-fact')]);
    jest.spyOn(svc as any, 'findUserMatches').mockResolvedValue(['private fact']);
    claudeCli.text.mockImplementation(async () => {
      revoked = true;
      return null;
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { choices: [{ message: { content: 'YES' } }] },
    });

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ skipped: 'privacy' });
    expect(post).not.toHaveBeenCalled();
  });

  it('does not call grouping OpenRouter fallback when Claude fails after revocation', async () => {
    let revoked = false;
    automaticProfilingAllowedMock.mockImplementation(async () => !revoked);
    const { svc, neo4j, claudeCli } = makeService();
    neo4j.listEntitiesForCompaction.mockResolvedValue(trustedEntities(12));
    claudeCli.text.mockImplementation(async () => {
      revoked = true;
      throw new Error('Claude unavailable');
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { choices: [{ message: { content: '{"groups":[]}' } }] },
    });

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ skipped: 'privacy' });
    expect(post).not.toHaveBeenCalled();
  });
});
