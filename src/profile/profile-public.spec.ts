import { readProfileAccess } from '../privacy/profile-privacy';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

jest.mock('../privacy/profile-privacy', () => ({
  readProfileAccess: jest.fn(),
  // Сохраняют поведение старой реализации во время RED-прогона.
  canViewProfile: jest.fn().mockResolvedValue(true),
  canUseProfileForRequester: jest.fn().mockResolvedValue(true),
}));

const readAccess = readProfileAccess as jest.MockedFunction<typeof readProfileAccess>;

function access(overrides: Record<string, any> = {}) {
  return {
    exists: true,
    visible: true,
    automaticProfiling: true,
    approvedContact: false,
    peer: false,
    ...overrides,
  };
}

const flatKeys = ['values', 'beliefs', 'desires', 'intents', 'interests', 'skills'] as const;

function targetRow() {
  return {
    user_id: 'target',
    profile_data: {
      name: 'PG name',
      family_name: 'PG family',
      user_nickname: 'pg-nick',
      avatar_url: 'https://example.test/pg-avatar.jpg',
      values: ['stale pg value'],
      beliefs: ['stale pg belief'],
      desires: ['stale pg desire'],
      intents: ['stale pg intent'],
      interests: ['stale pg interest'],
      skills: ['stale pg skill'],
      business: { revenue: 'private business' },
      birthday: '1990-01-01',
      contactVisible: 'private',
    },
  };
}

function neoEntities() {
  return {
    name: 'Neo name',
    family_name: 'Neo family',
    values: ['neo value'],
    beliefs: [],
    desires: ['neo desire'],
    intents: ['neo intent'],
    interests: ['neo interest'],
    skills: ['neo skill'],
  };
}

function makeService(neo: any = neoEntities()) {
  const pg = { query: jest.fn().mockResolvedValue({ rows: [targetRow()] }) };
  const neo4j = { getProfileEntities: jest.fn().mockResolvedValue(neo) };
  return {
    pg,
    neo4j,
    service: new ProfileService(pg as any, neo4j as any),
  };
}

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (status: number) => {
    res.statusCode = status;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

describe('other-user profile serialization', () => {
  beforeEach(() => {
    readAccess.mockReset().mockResolvedValue(access());
  });

  it('with automatic profiling disabled uses PG public fields and no Neo or stale PG entities', async () => {
    readAccess.mockResolvedValue(access({ automaticProfiling: false }));
    const { service, neo4j } = makeService();

    const result = await service.getUserProfile('viewer', 'target');

    expect(neo4j.getProfileEntities).not.toHaveBeenCalled();
    expect(result).toEqual({
      user_id: 'target',
      profile_data: {
        name: 'PG name',
        family_name: 'PG family',
        user_nickname: 'pg-nick',
        avatar_url: 'https://example.test/pg-avatar.jpg',
        values: [],
        beliefs: [],
        desires: [],
        intents: [],
        interests: [],
        skills: [],
      },
      name: 'PG name',
      family_name: 'PG family',
      values: [],
      beliefs: [],
      desires: [],
      intents: [],
      interests: [],
      skills: [],
    });
    expect(JSON.stringify(result)).not.toContain('private business');
    expect(JSON.stringify(result)).not.toContain('stale pg');
    expect(JSON.stringify(result)).not.toContain('Neo');
  });

  it('treats Neo empty arrays as authoritative and falls back only for absent keys', async () => {
    const neo: any = neoEntities();
    delete neo.desires;
    const { service, neo4j } = makeService(neo);

    const result = await service.getUserProfile('viewer', 'target');

    expect(neo4j.getProfileEntities).toHaveBeenCalledWith('target');
    expect(result).toMatchObject({
      user_id: 'target',
      name: 'Neo name',
      family_name: 'Neo family',
      values: ['neo value'],
      beliefs: [],
      desires: ['stale pg desire'],
      profile_data: {
        name: 'Neo name',
        family_name: 'Neo family',
        user_nickname: 'pg-nick',
        avatar_url: 'https://example.test/pg-avatar.jpg',
        values: ['neo value'],
        beliefs: [],
        desires: ['stale pg desire'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('stale pg belief');
    expect(JSON.stringify(result)).not.toContain('private business');
  });

  it('keeps own entities visible to self even when profiling is paused for others', async () => {
    readAccess.mockResolvedValue(access({ automaticProfiling: false }));
    const { service } = makeService();

    const result = await service.getUserProfile('target', 'target');

    expect(readAccess).toHaveBeenCalledWith(expect.anything(), 'target', 'target');
    expect(result).toMatchObject({ values: ['neo value'] });
  });

  it('uses one access snapshot per checkpoint when visibility and profiling are revoked', async () => {
    readAccess
      .mockResolvedValueOnce(access())
      .mockResolvedValueOnce(access({ visible: false, automaticProfiling: false }));
    const { service, pg } = makeService();

    await expect(service.getUserProfile('viewer', 'target')).resolves.toBeNull();
    expect(readAccess).toHaveBeenCalledTimes(2);
    expect(readAccess.mock.calls).toEqual([
      [pg, 'viewer', 'target'],
      [pg, 'viewer', 'target'],
    ]);
  });

  it('uses the final profiling snapshot and suppresses entities read earlier in the request', async () => {
    readAccess
      .mockResolvedValueOnce(access())
      .mockResolvedValueOnce(access({ automaticProfiling: false }));
    const { service, neo4j } = makeService();

    const result = await service.getUserProfile('viewer', 'target');

    expect(readAccess).toHaveBeenCalledTimes(2);
    expect(neo4j.getProfileEntities).toHaveBeenCalledWith('target');
    expect(result).toMatchObject({ name: 'PG name', family_name: 'PG family' });
    for (const key of flatKeys) {
      expect(result[key]).toEqual([]);
      expect(result.profile_data[key]).toEqual([]);
    }
  });
});

describe('GET /user-profile privacy response', () => {
  it('passes requester and target and preserves the legacy error with the public code', async () => {
    const profileService = { getUserProfile: jest.fn().mockResolvedValue(null) };
    const controller = new ProfileController(profileService as any, null as any);
    const res = mockRes();

    await controller.getUserProfile({ userId: 'viewer' }, 'target', res);

    expect(profileService.getUserProfile).toHaveBeenCalledWith('viewer', 'target');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'PROFILE_NOT_AVAILABLE' });
  });
});
