const { IdentityService } = require('../../dist/identity/identity.service');

function makePg(scripted) {
  let i = 0;
  return { query: jest.fn(async () => {
    const r = scripted[i++];
    if (!r) throw new Error(`unexpected pg.query #${i}`);
    return r;
  }) };
}

describe('linkMethod', () => {
  test('успешная привязка нового метода', async () => {
    const pg = makePg([
      { rows: [] },
      { rows: [], rowCount: 1 },
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.linkMethod('u1', 'email', { email: 'new@x.com' });
    expect(out).toEqual({ ok: true });
  });

  test('attempt на чужую identity — conflict', async () => {
    const pg = makePg([
      { rows: [{ user_id: 'u-other' }] },
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.linkMethod('u1', 'email', { email: 'taken@x.com' });
    expect(out).toEqual({ ok: false, reason: 'conflict', conflictUserId: 'u-other' });
  });

  test('повторная привязка той же identity своему userId — ok', async () => {
    const pg = makePg([
      { rows: [{ user_id: 'u1' }] },
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.linkMethod('u1', 'email', { email: 'mine@x.com' });
    expect(out).toEqual({ ok: true });
  });
});

describe('unlinkMethod', () => {
  test('успешно удаляет когда есть другие методы', async () => {
    const pg = makePg([
      { rows: [{ count: 2 }] },
      { rows: [], rowCount: 1 },
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.unlinkMethod('u1', 'identity-uuid');
    expect(out).toEqual({ ok: true });
  });

  test('отказ если это последний метод', async () => {
    const pg = makePg([
      { rows: [{ count: 1 }] },
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.unlinkMethod('u1', 'identity-uuid');
    expect(out).toEqual({ ok: false, reason: 'last_method' });
  });
});

describe('listIdentities', () => {
  test('возвращает identities юзера в camelCase', async () => {
    const pg = makePg([
      { rows: [
        { id: 'a', provider: 'phone', provider_sub: '79030169187', email: null, email_verified: false, created_at: '2026-01-01', last_used_at: '2026-05-28' },
        { id: 'b', provider: 'email', provider_sub: 'me@x.com', email: 'me@x.com', email_verified: true, created_at: '2026-05-28', last_used_at: null },
      ]},
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.listIdentities('u1');
    expect(out).toEqual([
      { id: 'a', provider: 'phone', providerSub: '79030169187', email: null, emailVerified: false, createdAt: '2026-01-01', lastUsedAt: '2026-05-28' },
      { id: 'b', provider: 'email', providerSub: 'me@x.com', email: 'me@x.com', emailVerified: true, createdAt: '2026-05-28', lastUsedAt: null },
    ]);
  });
});
