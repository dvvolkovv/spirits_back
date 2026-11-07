import { canUseProfileForRequester, canViewProfile } from '../privacy/profile-privacy';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

jest.mock('../privacy/profile-privacy', () => ({
  canViewProfile: jest.fn(),
  canUseProfileForRequester: jest.fn(),
}));

const canView = canViewProfile as jest.MockedFunction<typeof canViewProfile>;
const canUse = canUseProfileForRequester as jest.MockedFunction<typeof canUseProfileForRequester>;

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
    canView.mockReset().mockResolvedValue(true);
    canUse.mockReset().mockResolvedValue(true);
  });

  it('with automatic profiling disabled uses PG public fields and no Neo or stale PG entities', async () => {
    canUse.mockResolvedValue(false);
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

  it('with automatic profiling enabled preserves Neo preference and PG entity fallback', async () => {
    const { service, neo4j } = makeService();

    const result = await service.getUserProfile('viewer', 'target');

    expect(neo4j.getProfileEntities).toHaveBeenCalledWith('target');
    expect(result).toMatchObject({
      user_id: 'target',
      name: 'Neo name',
      family_name: 'Neo family',
      values: ['neo value'],
      beliefs: ['stale pg belief'],
      profile_data: {
        name: 'Neo name',
        family_name: 'Neo family',
        user_nickname: 'pg-nick',
        avatar_url: 'https://example.test/pg-avatar.jpg',
        values: ['neo value'],
        beliefs: ['stale pg belief'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('private business');
  });

  it('keeps own entities visible to self even when profiling is paused for others', async () => {
    const { service } = makeService();

    const result = await service.getUserProfile('target', 'target');

    expect(canView).toHaveBeenCalledWith(expect.anything(), 'target', 'target');
    expect(canUse).toHaveBeenCalledWith(expect.anything(), 'target', 'target');
    expect(result).toMatchObject({ values: ['neo value'] });
  });

  it('returns null when visibility changes to hidden during the request', async () => {
    canView.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { service } = makeService();

    await expect(service.getUserProfile('viewer', 'target')).resolves.toBeNull();
    expect(canView).toHaveBeenCalledTimes(2);
  });

  it('uses the final profiling decision and suppresses entities read earlier in the request', async () => {
    canUse.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { service, neo4j } = makeService();

    const result = await service.getUserProfile('viewer', 'target');

    expect(neo4j.getProfileEntities).toHaveBeenCalledWith('target');
    expect(result).toMatchObject({ name: 'PG name', family_name: 'PG family' });
    for (const key of flatKeys) {
      expect(result[key]).toEqual([]);
      expect(result.profile_data[key]).toEqual([]);
    }
  });
});

describe('GET /user-profile privacy response', () => {
  it('passes requester and target to the service and hides missing profiles with one public code', async () => {
    const profileService = { getUserProfile: jest.fn().mockResolvedValue(null) };
    const controller = new ProfileController(profileService as any, null as any);
    const res = mockRes();

    await controller.getUserProfile({ userId: 'viewer' }, 'target', res);

    expect(profileService.getUserProfile).toHaveBeenCalledWith('viewer', 'target');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
  });
});
