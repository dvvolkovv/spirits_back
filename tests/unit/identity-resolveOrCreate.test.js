const { IdentityService } = require('../../dist/identity/identity.service');

// Управляющие команды inTransaction (src/blog/blog-slot-claim.ts) — он шлёт их
// на выделенный клиент ровно такими строками.
const TX_CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK']);

/**
 * Фейк PgService со сценарием ответов.
 *
 * Очередь одна на pg.query и на query клиента из getClient(): порядок запросов
 * resolveOrCreate детерминирован, поэтому сценарий читается сверху вниз ровно
 * в том порядке, в каком их шлёт код. BEGIN/COMMIT/ROLLBACK очередь не
 * расходуют (ответ { rows: [] }), но остаются в tx.query.mock.calls.
 * Запрос без ответа в сценарии — исключение: дрейф кода должен ронять тест.
 */
function makePg(scripted) {
  let i = 0;
  const next = (who, sql) => {
    const r = scripted[i++];
    if (!r) throw new Error(`${who} #${i} unexpected: ${sql.slice(0, 60)}`);
    return r;
  };
  const tx = {
    query: jest.fn(async (sql) => (TX_CONTROL.has(sql) ? { rows: [] } : next('tx.query', sql))),
    release: jest.fn(),
  };
  return {
    query: jest.fn(async (sql) => next('pg.query', sql)),
    getClient: jest.fn(async () => tx),
    tx,
  };
}

describe('IdentityService.resolveOrCreate', () => {
  test('lookup существующей identity → возвращает userId, isNew=false', async () => {
    const pg = makePg([
      { rows: [{ user_id: 'u1' }] },   // lookup user_identities — связка есть
      { rows: [{ state: 'active' }] }, // SELECT state (reactivateDeletedOnLogin) — не deleted, реактивации нет
      { rows: [], rowCount: 1 },       // UPDATE last_used_at
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.resolveOrCreate('phone', { phone: '79030169187' });
    expect(out).toEqual({ status: 'ok', userId: 'u1', isNew: false, mergedExisting: false });
  });

  test('новый user — INSERT user_id, ai_profiles_consolidated, user_identities, welcome bonus', async () => {
    const pg = makePg([
      { rows: [] },                                             // lookup user_identities — связки нет
      // шаг 3 — inTransaction: дальше tx.query клиента из getClient()
      { rows: [{ internal_id: '79030169187' }], rowCount: 1 }, // INSERT user_id … ON CONFLICT DO NOTHING
      { rows: [{ deletion_id: null }] },                        // SELECT deletion_id … FOR UPDATE (reactivateIfNeeded)
      { rows: [], rowCount: 0 },                                // UPDATE user_id SET state = 'active' (reactivateIfNeeded) — строка уже active
      { rows: [], rowCount: 1 },                                // INSERT ai_profiles_consolidated (ensureProfileRow)
      { rows: [], rowCount: 1 },                                // INSERT user_identities (ensureProfileAndIdentity)
      { rows: [{ internal_id: '79030169187' }], rowCount: 1 }, // UPDATE welcome_bonus_at … RETURNING (issueWelcomeBonus) — claim взят
      { rows: [{ add_user_tokens: {} }], rowCount: 1 },         // SELECT add_user_tokens (issueWelcomeBonus) — результат не читается
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.resolveOrCreate('phone', { phone: '79030169187' });
    expect(out.isNew).toBe(true);
    expect(out.userId).toBe('79030169187');
    expect(out.mergedExisting).toBe(false);
    const txSql = pg.tx.query.mock.calls.map(([sql]) => sql);
    expect(txSql[0]).toBe('BEGIN');
    expect(txSql[txSql.length - 1]).toBe('COMMIT');
    expect(pg.tx.release).toHaveBeenCalledTimes(1);
  });

  test('OAuth с verified email — merge к существующему юзеру', async () => {
    const pg = makePg([
      { rows: [] },                        // lookup user_identities — связки google нет
      { rows: [{ user_id: 'EXISTING' }] }, // SELECT user_id по verified email — аккаунт найден
      { rows: [], rowCount: 1 },           // INSERT user_identities — связка google к нему
      { rows: [{ state: 'active' }] },     // SELECT state (reactivateDeletedOnLogin) — не deleted, реактивации нет
    ]);
    const svc = new IdentityService(pg);
    const out = await svc.resolveOrCreate('google', { sub: 'g-123', email: 'foo@gmail.com', emailVerified: true });
    expect(out).toEqual({ status: 'ok', userId: 'EXISTING', isNew: false, mergedExisting: true });
  });

  test('phone нормализуется (убираем +, скобки, пробелы)', async () => {
    const pg = makePg([
      { rows: [{ user_id: 'u1' }] },   // lookup user_identities — связка есть
      { rows: [{ state: 'active' }] }, // SELECT state (reactivateDeletedOnLogin) — не deleted, реактивации нет
      { rows: [], rowCount: 1 },       // UPDATE last_used_at
    ]);
    const svc = new IdentityService(pg);
    await svc.resolveOrCreate('phone', { phone: '+7 (903) 016-91-87' });
    const lookupParams = pg.query.mock.calls[0][1];
    expect(lookupParams).toContain('79030169187');
  });
});
