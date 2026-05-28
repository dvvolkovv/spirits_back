const { IdentityService } = require('../../dist/identity/identity.service');

function makePg(scripted) {
  let i = 0;
  return {
    query: jest.fn(async (sql, params) => {
      const r = scripted[i++];
      if (!r) throw new Error(`pg.query #${i} unexpected: ${sql.slice(0,60)}`);
      return r;
    }),
  };
}

describe('IdentityService.resolveOrCreate', () => {
  test('lookup существующей identity → возвращает userId, isNew=false', async () => {
    const pg = makePg([
      { rows: [{ user_id: 'u1' }] },
      { rows: [], rowCount: 1 },
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.resolveOrCreate('phone', { phone: '79030169187' });
    expect(out).toEqual({ userId: 'u1', isNew: false, mergedExisting: false });
  });

  test('новый user — INSERT user_id, ai_profiles_consolidated, user_identities, welcome bonus', async () => {
    const pg = makePg([
      { rows: [] },
      { rows: [], rowCount: 0 },
      { rows: [{ internal_id: '79030169187' }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ internal_id: '79030169187' }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.resolveOrCreate('phone', { phone: '79030169187' });
    expect(out.isNew).toBe(true);
    expect(out.userId).toBe('79030169187');
    expect(out.mergedExisting).toBe(false);
  });

  test('OAuth с verified email — merge к существующему юзеру', async () => {
    const pg = makePg([
      { rows: [] },
      { rows: [{ user_id: 'EXISTING' }] },
      { rows: [], rowCount: 1 },
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.resolveOrCreate('google', { sub: 'g-123', email: 'foo@gmail.com', emailVerified: true });
    expect(out).toEqual({ userId: 'EXISTING', isNew: false, mergedExisting: true });
  });

  test('phone нормализуется (убираем +, скобки, пробелы)', async () => {
    const pg = makePg([
      { rows: [{ user_id: 'u1' }] },
      { rows: [], rowCount: 1 },
    ]);
    const svc = new IdentityService(pg);
    await svc.resolveOrCreate('phone', { phone: '+7 (903) 016-91-87' });
    const lookupParams = pg.query.mock.calls[0][1];
    expect(lookupParams).toContain('79030169187');
  });
});
