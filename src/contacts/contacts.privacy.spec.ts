import { BadRequestException, NotFoundException } from '@nestjs/common';
import { canReceiveNewProposal, readProfileAccess } from '../privacy/profile-privacy';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

jest.mock('../privacy/profile-privacy', () => ({
  canReceiveNewProposal: jest.fn(),
  readProfileAccess: jest.fn(),
  readProfileAccessBatch: jest.fn(),
}));

const canReceive = canReceiveNewProposal as jest.MockedFunction<typeof canReceiveNewProposal>;
const readAccess = readProfileAccess as jest.MockedFunction<typeof readProfileAccess>;
const readBatch = (jest.requireMock('../privacy/profile-privacy') as any).readProfileAccessBatch as jest.Mock;

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
const richKeys = ['valuesRich', 'beliefsRich', 'desiresRich', 'intentsRich', 'interestsRich', 'skillsRich'] as const;
const avatarUrl = 'https://example.test/avatars/users/target-phone.jpg';

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

function makeService(options: {
  requesterId?: number | null;
  self?: boolean;
  targetMissing?: boolean;
  visibility?: string;
  visibilitySequence?: string[];
} = {}) {
  const requesterPhone = options.self ? 'target-phone' : 'viewer-phone';
  const targetPhone = 'target-phone';
  const profileData = {
    name: 'PG name',
    family_name: 'PG family',
    avatar_url: avatarUrl,
    values: ['stale pg value'],
    valuesRich: [{ text: 'stale pg rich value' }],
    business: { revenue: 'private business' },
  };
  const visibilitySequence = options.visibilitySequence ?? [options.visibility ?? 'matchOnly'];
  let visibilityIndex = 0;
  const pg = {
    query: jest.fn(async (sql: string) => {
      // Task 17B: active-гейт createRequest — вызывающий аккаунт активен.
      if (sql.includes('FROM user_id WHERE internal_id')) {
        return { rows: [{ n: 1 }], rowCount: 1 };
      }
      if (sql.includes('SELECT user_id FROM ai_profiles_consolidated WHERE id')) {
        return {
          rows: options.targetMissing ? [] : [{ user_id: targetPhone }],
          rowCount: options.targetMissing ? 0 : 1,
        };
      }
      if (sql.includes('SELECT id FROM ai_profiles_consolidated WHERE user_id')) {
        const requesterId = options.requesterId === undefined ? 11 : options.requesterId;
        return { rows: requesterId === null ? [] : [{ id: requesterId }], rowCount: requesterId === null ? 0 : 1 };
      }
      if (sql.includes("profile_data->>'contactVisible'")) {
        const visibility = visibilitySequence[Math.min(visibilityIndex, visibilitySequence.length - 1)];
        visibilityIndex += 1;
        return { rows: [{ v: visibility }], rowCount: 1 };
      }
      if (sql.includes('FROM contact_requests')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM peer_conversations')) return { rows: [], rowCount: 0 };
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
    readAccess.mockReset().mockResolvedValue(access());
    readBatch.mockReset().mockResolvedValue(new Map());
  });

  it('returns null for a hidden stranger before relationship or entity work', async () => {
    readAccess.mockResolvedValue(access({ visible: false, approvedContact: true, peer: true }));
    const { service, pg, neo4j, requesterPhone } = makeService();

    await expect(service.getPublicProfile(requesterPhone, 22)).resolves.toBeNull();

    expect(readAccess).toHaveBeenCalledWith(pg, 'viewer-phone', 'target-phone');
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(neo4j.getProfileEntities).not.toHaveBeenCalled();
  });

  it('for a paused visible stranger returns PG names, empty entities, no Neo and no phone-bearing avatar', async () => {
    readAccess.mockResolvedValue(access({ automaticProfiling: false }));
    const { service, neo4j, requesterPhone } = makeService();

    const result = await service.getPublicProfile(requesterPhone, 22);

    expect(neo4j.getProfileEntities).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      userId: 22,
      name: 'PG name',
      family_name: 'PG family',
      avatar_url: null,
      email: null,
      phone: null,
      contactVisible: 'matchOnly',
      phoneDisclosed: false,
    });
    for (const key of [...flatKeys, ...richKeys]) expect(result[key]).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('stale pg');
    expect(JSON.stringify(result)).not.toContain('private business');
    expect(JSON.stringify(result)).not.toContain('Neo');
    expect(JSON.stringify(result)).not.toContain('target-phone');
  });

  it.each(['matchOnly', 'private'])('does not expose a phone through avatar_url to a %s stranger', async (visibility) => {
    readAccess.mockResolvedValue(access({ automaticProfiling: false }));
    const { service, requesterPhone } = makeService({ visibility });

    const result = await service.getPublicProfile(requesterPhone, 22);

    expect(result).toMatchObject({ phoneDisclosed: false, phone: null, email: null, avatar_url: null });
    expect(JSON.stringify(result)).not.toContain('target-phone');
  });

  it('keeps own Neo entities, phone and avatar when paused for others', async () => {
    readAccess.mockResolvedValue(access({ automaticProfiling: false }));
    const { service, neo4j, targetPhone } = makeService({ self: true, requesterId: 22 });

    const result = await service.getPublicProfile(targetPhone, 22);

    expect(readAccess).toHaveBeenCalledWith(expect.anything(), targetPhone, targetPhone);
    expect(neo4j.getProfileEntities).toHaveBeenCalledWith(targetPhone);
    expect(result).toMatchObject({
      name: 'Neo name',
      family_name: 'Neo family',
      avatar_url: avatarUrl,
      email: 'target@example.test',
      phone: targetPhone,
      phoneDisclosed: true,
    });
    for (const key of [...flatKeys, ...richKeys]) expect(result[key]).toEqual(neoEntities()[key]);
  });

  it('uses one access snapshot per checkpoint when visibility and profiling are revoked', async () => {
    readAccess
      .mockResolvedValueOnce(access())
      .mockResolvedValueOnce(access({ visible: false, automaticProfiling: false }));
    const { service, pg, requesterPhone } = makeService();

    await expect(service.getPublicProfile(requesterPhone, 22)).resolves.toBeNull();
    expect(readAccess).toHaveBeenCalledTimes(2);
    expect(readAccess.mock.calls).toEqual([
      [pg, 'viewer-phone', 'target-phone'],
      [pg, 'viewer-phone', 'target-phone'],
    ]);
  });

  it('uses the final profiling snapshot and empties flat and rich arrays read earlier', async () => {
    readAccess
      .mockResolvedValueOnce(access())
      .mockResolvedValueOnce(access({ automaticProfiling: false }));
    const { service, neo4j, requesterPhone } = makeService();

    const result = await service.getPublicProfile(requesterPhone, 22);

    expect(readAccess).toHaveBeenCalledTimes(2);
    expect(neo4j.getProfileEntities).toHaveBeenCalledWith('target-phone');
    expect(result).toMatchObject({ name: 'PG name', family_name: 'PG family' });
    for (const key of [...flatKeys, ...richKeys]) expect(result[key]).toEqual([]);
  });

  it.each([
    ['approved contact', { approvedContact: true }],
    ['peer conversation', { peer: true }],
  ])('uses %s from access snapshots without duplicate relationship SQL', async (_label, relationship) => {
    readAccess.mockResolvedValue(access({ automaticProfiling: false, ...relationship }));
    const { service, pg, requesterPhone, targetPhone } = makeService();

    const result = await service.getPublicProfile(requesterPhone, 22);

    expect(result).toMatchObject({
      phoneDisclosed: true,
      phone: targetPhone,
      email: 'target@example.test',
      avatar_url: avatarUrl,
    });
    const queries = pg.query.mock.calls.map((call) => call[0]);
    expect(queries.some((sql) => sql.includes('SELECT id FROM ai_profiles_consolidated WHERE user_id'))).toBe(false);
    expect(queries.some((sql) => sql.includes('FROM contact_requests'))).toBe(false);
    expect(queries.some((sql) => sql.includes('FROM peer_conversations'))).toBe(false);
  });

  it('re-reads contactVisible and revokes public phone, email and avatar before serialization', async () => {
    readAccess.mockResolvedValue(access({ automaticProfiling: false }));
    const { service, pg, requesterPhone } = makeService({ visibilitySequence: ['public', 'private'] });

    const result = await service.getPublicProfile(requesterPhone, 22);

    expect(result).toMatchObject({
      contactVisible: 'private',
      phoneDisclosed: false,
      phone: null,
      email: null,
      avatar_url: null,
    });
    const visibilityQueries = pg.query.mock.calls.filter((call) => call[0].includes("profile_data->>'contactVisible'"));
    expect(visibilityQueries).toHaveLength(2);
  });

  it('fails closed when the access snapshot cannot read the peer table', async () => {
    readAccess.mockRejectedValue(new Error('relation "peer_conversations" does not exist'));
    const { service, neo4j, requesterPhone } = makeService();

    await expect(service.getPublicProfile(requesterPhone, 22)).resolves.toBeNull();
    expect(neo4j.getProfileEntities).not.toHaveBeenCalled();
  });
});

type ListDirection = 'incoming' | 'outgoing';

function listRow(direction: ListDirection, status: 'pending' | 'approved') {
  const phoneKey = direction === 'incoming' ? 'requester_phone' : 'target_phone';
  const profileKey = direction === 'incoming' ? 'requester_profile_data' : 'target_profile_data';
  return {
    id: 1,
    requester_id: direction === 'incoming' ? 22 : 11,
    target_id: direction === 'incoming' ? 11 : 22,
    status,
    [phoneKey]: 'counterpart',
    [profileKey]: {
      name: 'PG name',
      family_name: 'PG family',
      business: { revenue: 'private business' },
    },
  };
}

function makeListService(direction: ListDirection, rows: any[]) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT id FROM ai_profiles_consolidated WHERE user_id')) {
        return { rows: [{ id: 11 }], rowCount: 1 };
      }
      if (sql.includes('FROM contact_requests cr')) return { rows, rowCount: rows.length };
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
  const neo4j = {
    getProfileEntities: jest.fn(async (phone: string) => ({ name: `Neo ${phone}`, family_name: 'Neo family' })),
  };
  return {
    pg,
    neo4j,
    direction,
    service: new ContactsService(pg as any, neo4j as any),
  };
}

async function callList(service: ContactsService, direction: ListDirection): Promise<any[]> {
  return direction === 'incoming' ? service.listIncoming('owner') : service.listOutgoing('owner');
}

describe.each(['incoming', 'outgoing'] as ListDirection[])('ContactsService %s list privacy', (direction) => {
  const phoneKey = direction === 'incoming' ? 'requester_phone' : 'target_phone';
  const nameKey = direction === 'incoming' ? 'requester_name' : 'target_name';

  beforeEach(() => {
    readAccess.mockReset().mockResolvedValue(access());
    readBatch.mockReset().mockResolvedValue(new Map());
  });

  it('removes an approved counterparty revoked by a block', async () => {
    readBatch.mockResolvedValue(new Map([
      ['counterpart', access({ visible: false, approvedContact: true, peer: true })],
    ]));
    const { service, pg, neo4j } = makeListService(direction, [listRow(direction, 'approved')]);

    await expect(callList(service, direction)).resolves.toEqual([]);
    expect(readBatch).toHaveBeenCalledTimes(1);
    expect(readBatch).toHaveBeenCalledWith(pg, 'owner', ['counterpart']);
    expect(neo4j.getProfileEntities).not.toHaveBeenCalled();
  });

  it('does not expose a hidden counterparty row', async () => {
    readBatch.mockResolvedValue(new Map([['counterpart', access({ visible: false })]]));
    const { service, neo4j } = makeListService(direction, [listRow(direction, 'pending')]);

    await expect(callList(service, direction)).resolves.toEqual([]);
    expect(readBatch).toHaveBeenCalledTimes(1);
    expect(neo4j.getProfileEntities).not.toHaveBeenCalled();
  });

  it('keeps an allowed approved paused counterparty with a PG public name and no Neo read', async () => {
    readBatch.mockResolvedValue(new Map([['counterpart', access({ automaticProfiling: false })]]));
    const { service, neo4j } = makeListService(direction, [listRow(direction, 'approved')]);

    const result = await callList(service, direction);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ [phoneKey]: 'counterpart', [nameKey]: 'PG name PG family' });
    expect(neo4j.getProfileEntities).not.toHaveBeenCalled();
    expect(readBatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private business');
    expect(JSON.stringify(result)).not.toContain('profile_data');
  });

  it('preserves pending phone suppression for an allowed unpaused counterparty', async () => {
    readBatch.mockResolvedValue(new Map([['counterpart', access()]]));
    const { service } = makeListService(direction, [listRow(direction, 'pending')]);

    const result = await callList(service, direction);

    expect(result).toHaveLength(1);
    expect(result[0][phoneKey]).toBeUndefined();
    expect(result[0][nameKey]).toBe('Neo counterpart Neo family');
    expect(readBatch).toHaveBeenCalledTimes(1);
  });
});

async function expectProfileNotAvailable(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => { throw new Error('Expected PROFILE_NOT_AVAILABLE'); },
    (reason) => reason,
  );
  expect(error).toBeInstanceOf(NotFoundException);
  const httpError = error as NotFoundException;
  expect(httpError.getStatus()).toBe(404);
  expect(httpError.getResponse()).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
}

describe('ContactsService.createRequest privacy', () => {
  beforeEach(() => {
    canReceive.mockReset().mockResolvedValue(true);
  });

  it('rejects a hidden public target before contactVisible and creates no approved row', async () => {
    canReceive.mockResolvedValue(false);
    const { service, pg, requesterPhone } = makeService({ visibility: 'public' });

    await expectProfileNotAvailable(service.createRequest(requesterPhone, 22, 'hello'));

    expect(canReceive).toHaveBeenCalledWith(pg, 'target-phone');
    const queries = pg.query.mock.calls.map((call) => call[0]);
    expect(queries.some((sql) => sql.includes("profile_data->>'contactVisible'"))).toBe(false);
    expect(queries.some((sql) => sql.includes('INSERT INTO contact_requests'))).toBe(false);
    // Task 17B: active-гейт + idByPhone + phoneById (было 2 до появления гейта).
    expect(pg.query).toHaveBeenCalledTimes(3);
  });

  it('returns the same 404 for a missing target before contactVisible or insertion', async () => {
    canReceive.mockResolvedValue(false);
    const { service, pg, requesterPhone } = makeService({ targetMissing: true, visibility: 'public' });

    await expectProfileNotAvailable(service.createRequest(requesterPhone, 22, 'hello'));

    const queries = pg.query.mock.calls.map((call) => call[0]);
    expect(queries.some((sql) => sql.includes("profile_data->>'contactVisible'"))).toBe(false);
    expect(queries.some((sql) => sql.includes('INSERT INTO contact_requests'))).toBe(false);
  });
});

describe('contact request controller privacy responses', () => {
  it('preserves the service HttpException instead of converting it to 400', async () => {
    const error = new NotFoundException({ code: 'PROFILE_NOT_AVAILABLE' });
    const contacts = { createRequest: jest.fn().mockRejectedValue(error) };
    const controller = new ContactsController(contacts as any);
    const res = mockRes();

    await expect(controller.createRequest({ userId: 'viewer-phone' }, { userId: 22 }, res)).rejects.toBe(error);
    expect(res.statusCode).toBe(0);
  });

  it('retains the legacy 400 response for non-HTTP errors', async () => {
    const contacts = { createRequest: jest.fn().mockRejectedValue(new Error('legacy failure')) };
    const controller = new ContactsController(contacts as any);
    const res = mockRes();

    await controller.createRequest({ userId: 'viewer-phone' }, { userId: 22 }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'legacy failure' });
  });
});

describe('public contact controller privacy responses', () => {
  it('returns the legacy error and shared code for a missing or hidden public profile', async () => {
    const contacts = { getPublicProfile: jest.fn().mockResolvedValue(null) };
    const controller = new ContactsController(contacts as any);
    const res = mockRes();

    await controller.publicProfile({ userId: 'viewer-phone' }, '22', res);

    expect(contacts.getPublicProfile).toHaveBeenCalledWith('viewer-phone', 22);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', code: 'PROFILE_NOT_AVAILABLE' });
  });

  it('returns the same body when phone lookup has no target', async () => {
    const contacts = { idByPhone: jest.fn().mockResolvedValue(null), getPublicProfile: jest.fn() };
    const controller = new ContactsController(contacts as any);
    const res = mockRes();

    await controller.publicProfileByPhone({ userId: 'viewer-phone' }, 'missing-phone', res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', code: 'PROFILE_NOT_AVAILABLE' });
    expect(contacts.getPublicProfile).not.toHaveBeenCalled();
  });

  it('returns the same body when the phone target becomes hidden', async () => {
    const contacts = { idByPhone: jest.fn().mockResolvedValue(22), getPublicProfile: jest.fn().mockResolvedValue(null) };
    const controller = new ContactsController(contacts as any);
    const res = mockRes();

    await controller.publicProfileByPhone({ userId: 'viewer-phone' }, 'target-phone', res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', code: 'PROFILE_NOT_AVAILABLE' });
  });

  it.each(['Infinity', '1.5', '0', '-2', 'NaN'])('rejects invalid publicProfile id %s with 400 before profile lookup', async (raw) => {
    const contacts = { getPublicProfile: jest.fn() };
    const controller = new ContactsController(contacts as any);

    await expect(controller.publicProfile({ userId: 'viewer-phone' }, raw, mockRes())).rejects.toBeInstanceOf(BadRequestException);
    expect(contacts.getPublicProfile).not.toHaveBeenCalled();
  });

  it.each([Infinity, 1.5, 0, -2, NaN])('rejects resolved publicProfileByPhone id %s with 400 before profile lookup', async (id) => {
    const contacts = { idByPhone: jest.fn().mockResolvedValue(id), getPublicProfile: jest.fn() };
    const controller = new ContactsController(contacts as any);

    await expect(controller.publicProfileByPhone({ userId: 'viewer-phone' }, 'target-phone', mockRes())).rejects.toBeInstanceOf(BadRequestException);
    expect(contacts.getPublicProfile).not.toHaveBeenCalled();
  });
});
