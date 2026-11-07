import { canUseProfileForRequester, canViewProfile } from '../privacy/profile-privacy';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

jest.mock('../privacy/profile-privacy', () => ({
  canViewProfile: jest.fn(),
  canUseProfileForRequester: jest.fn(),
}));

const canView = canViewProfile as jest.MockedFunction<typeof canViewProfile>;
const canUse = canUseProfileForRequester as jest.MockedFunction<typeof canUseProfileForRequester>;

const flatKeys = ['values', 'beliefs', 'desires', 'intents', 'interests', 'skills'] as const;
const richKeys = ['valuesRich', 'beliefsRich', 'desiresRich', 'intentsRich', 'interestsRich', 'skillsRich'] as const;

function neoEntities() {
  return {
    name: 'Neo name',
    family_name: 'Neo family',
    values: ['neo value'],
    beliefs: ['neo belief'],
    desires: ['neo desire'],
    intents: ['neo intent'],
    interests: ['neo interest'],
    skills: ['neo skill'],
    valuesRich: [{ text: 'neo rich value' }],
    beliefsRich: [{ text: 'neo rich belief' }],
    desiresRich: [{ text: 'neo rich desire' }],
    intentsRich: [{ text: 'neo rich intent' }],
    interestsRich: [{ text: 'neo rich interest' }],
    skillsRich: [{ text: 'neo rich skill' }],
  };
}

function makeService(options: { requesterId?: number | null; self?: boolean } = {}) {
  const requesterPhone = options.self ? 'target-phone' : 'viewer-phone';
  const targetPhone = 'target-phone';
  const profileData = {
    name: 'PG name',
    family_name: 'PG family',
    avatar_url: 'https://example.test/pg-avatar.jpg',
    values: ['stale pg value'],
    valuesRich: [{ text: 'stale pg rich value' }],
    business: { revenue: 'private business' },
  };
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT user_id FROM ai_profiles_consolidated WHERE id')) {
        return { rows: [{ user_id: targetPhone }], rowCount: 1 };
      }
      if (sql.includes('SELECT id FROM ai_profiles_consolidated WHERE user_id')) {
        const requesterId = options.requesterId === undefined ? 11 : options.requesterId;
        return { rows: requesterId === null ? [] : [{ id: requesterId }], rowCount: requesterId === null ? 0 : 1 };
      }
      if (sql.includes("profile_data->>'contactVisible'")) {
        return { rows: [{ v: 'matchOnly' }], rowCount: 1 };
      }
      if (sql.includes('FROM contact_requests')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM peer_conversations')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT email, profile_data FROM ai_profiles_consolidated')) {
        return { rows: [{ email: 'target@example.test', profile_data: profileData }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
  const neo4j = { getProfileEntities: jest.fn().mockResolvedValue(neoEntities()) };
  return {
    pg,
    neo4j,
    requesterPhone,
    targetPhone,
    service: new ContactsService(pg as any, neo4j as any),
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

describe('ContactsService.getPublicProfile privacy', () => {
  beforeEach(() => {
    canView.mockReset().mockResolvedValue(true);
    canUse.mockReset().mockResolvedValue(true);
  });

  it('returns null for a hidden stranger before relationship or entity work', async () => {
    canView.mockResolvedValue(false);
    const { service, pg, neo4j, requesterPhone } = makeService();

    await expect(service.getPublicProfile(requesterPhone, 22)).resolves.toBeNull();

    expect(canView).toHaveBeenCalledWith(pg, 'viewer-phone', 'target-phone');
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(neo4j.getProfileEntities).not.toHaveBeenCalled();
  });

  it('for a paused visible profile returns PG public fields and empty flat and rich arrays without Neo', async () => {
    canUse.mockResolvedValue(false);
    const { service, neo4j, requesterPhone } = makeService();

    const result = await service.getPublicProfile(requesterPhone, 22);

    expect(neo4j.getProfileEntities).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      userId: 22,
      name: 'PG name',
      family_name: 'PG family',
      avatar_url: 'https://example.test/pg-avatar.jpg',
      email: null,
      phone: null,
      contactVisible: 'matchOnly',
      phoneDisclosed: false,
    });
    for (const key of [...flatKeys, ...richKeys]) expect(result[key]).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('stale pg');
    expect(JSON.stringify(result)).not.toContain('private business');
    expect(JSON.stringify(result)).not.toContain('Neo');
  });

  it('keeps own Neo entities and existing self phone disclosure when paused for others', async () => {
    const { service, neo4j, targetPhone } = makeService({ self: true, requesterId: 22 });

    const result = await service.getPublicProfile(targetPhone, 22);

    expect(canView).toHaveBeenCalledWith(expect.anything(), targetPhone, targetPhone);
    expect(canUse).toHaveBeenCalledWith(expect.anything(), targetPhone, targetPhone);
    expect(neo4j.getProfileEntities).toHaveBeenCalledWith(targetPhone);
    expect(result).toMatchObject({
      name: 'Neo name',
      family_name: 'Neo family',
      email: 'target@example.test',
      phone: targetPhone,
      phoneDisclosed: true,
    });
    for (const key of [...flatKeys, ...richKeys]) expect(result[key]).toEqual(neoEntities()[key]);
  });

  it('returns null when visibility changes to hidden during the request', async () => {
    canView.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { service, requesterPhone } = makeService();

    await expect(service.getPublicProfile(requesterPhone, 22)).resolves.toBeNull();
    expect(canView).toHaveBeenCalledTimes(2);
  });

  it('uses the final profiling decision and empties flat and rich arrays read earlier', async () => {
    canUse.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { service, neo4j, requesterPhone } = makeService();

    const result = await service.getPublicProfile(requesterPhone, 22);

    expect(neo4j.getProfileEntities).toHaveBeenCalledWith('target-phone');
    expect(result).toMatchObject({ name: 'PG name', family_name: 'PG family' });
    for (const key of [...flatKeys, ...richKeys]) expect(result[key]).toEqual([]);
  });
});

describe('public contact controller privacy responses', () => {
  it('returns the shared 404 code for a missing or hidden public profile', async () => {
    const contacts = { getPublicProfile: jest.fn().mockResolvedValue(null) };
    const controller = new ContactsController(contacts as any);
    const res = mockRes();

    await controller.publicProfile({ userId: 'viewer-phone' }, '22', res);

    expect(contacts.getPublicProfile).toHaveBeenCalledWith('viewer-phone', 22);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
  });

  it('returns the same 404 code when phone lookup has no target', async () => {
    const contacts = { idByPhone: jest.fn().mockResolvedValue(null), getPublicProfile: jest.fn() };
    const controller = new ContactsController(contacts as any);
    const res = mockRes();

    await controller.publicProfileByPhone({ userId: 'viewer-phone' }, 'missing-phone', res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
    expect(contacts.getPublicProfile).not.toHaveBeenCalled();
  });

  it('returns the same 404 code when the phone target becomes hidden', async () => {
    const contacts = { idByPhone: jest.fn().mockResolvedValue(22), getPublicProfile: jest.fn().mockResolvedValue(null) };
    const controller = new ContactsController(contacts as any);
    const res = mockRes();

    await controller.publicProfileByPhone({ userId: 'viewer-phone' }, 'target-phone', res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
  });
});
