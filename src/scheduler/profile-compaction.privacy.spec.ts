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
    query: jest.fn(async (): Promise<any> => ({ rows: [] })),
  };
  const neo4j = {
    listEntitiesForCompaction: jest.fn(),
    dropEntityRelation: jest.fn(async () => {}),
    mergeEntitiesInProfile: jest.fn(async () => {}),
  };
  const claudeCli = { text: jest.fn() };
  const svc = new ProfileCompactionService(pg as any, neo4j as any, claudeCli as any);
  return { svc, pg, neo4j, claudeCli };
}

describe('ProfileCompactionService automatic profiling privacy gates', () => {
  beforeEach(() => {
    automaticProfilingAllowedMock.mockReset().mockResolvedValue(true);
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

  it('stops before dropEntityRelation when consent is revoked after entry', async () => {
    automaticProfilingAllowedMock.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { svc, pg, neo4j } = makeService();
    neo4j.listEntitiesForCompaction.mockResolvedValue([
      {
        canonicalKey: 'private-fact',
        name: 'private fact',
        aliases: [],
        support: 1,
        updatedAt: new Date().toISOString(),
      },
    ]);

    const result = await svc.compactUser('u1');

    expect(result).toMatchObject({ userId: 'u1', skipped: 'privacy' });
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(neo4j.dropEntityRelation).not.toHaveBeenCalled();
    expect(neo4j.mergeEntitiesInProfile).not.toHaveBeenCalled();
  });

  it('prefilters disabled users in nightly SQL instead of relying only on compactUser', async () => {
    const { svc, pg, neo4j } = makeService();

    await svc.runDailyCompaction();

    expect(pg.query).toHaveBeenCalledTimes(1);
    const sql = pg.query.mock.calls[0][0] as string;
    expect(sql).toMatch(
      /FROM custom_chat_history h\s+JOIN ai_profiles_consolidated p ON p\.user_id\s*=\s*split_part\(h\.session_id,\s*'_',\s*1\)/i,
    );
    expect(sql).toMatch(/coalesce\(p\.profile_data->>'automaticProfiling',\s*'true'\)\s*=\s*'true'/i);
    expect(neo4j.listEntitiesForCompaction).not.toHaveBeenCalled();
  });
});
