/**
 * Unit-tests для CustomAgentsService — паттерн как в tasks-listForUser.test.js:
 * inline-копия метода + mock PgService.
 */

function makeListService(rows) {
  const pg = {
    queries: [],
    query(sql, params) {
      this.queries.push({ sql, params });
      return Promise.resolve({ rows });
    },
  };
  return {
    pg,
    async list(ownerId) {
      const r = await pg.query(
        `SELECT id, name, description, system_prompt, created_at, updated_at
           FROM custom_agents
          WHERE owner_user_id = $1
          ORDER BY updated_at DESC`,
        [ownerId],
      );
      return r.rows;
    },
  };
}

describe('CustomAgentsService.list', () => {
  test('возвращает агентов владельца, отсортированных по updated_at DESC', async () => {
    const s = makeListService([
      { id: 'a1', name: 'Кинокритик', description: null, system_prompt: 'sp', created_at: 't1', updated_at: 't2' },
    ]);
    const out = await s.list('owner-1');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Кинокритик');
    expect(s.pg.queries[0].params).toEqual(['owner-1']);
    expect(s.pg.queries[0].sql).toMatch(/ORDER BY updated_at DESC/);
  });
});

function makeGetByIdSvc(row) {
  const pg = {
    query: (sql, params) => Promise.resolve({ rows: row ? [row] : [] }),
  };
  return {
    async getById(id, ownerId) {
      const r = await pg.query(
        `SELECT * FROM custom_agents WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
        [id, ownerId],
      );
      if (r.rows.length === 0) {
        const err = new Error('NotFound');
        err.name = 'NotFoundException';
        throw err;
      }
      return r.rows[0];
    },
  };
}

describe('CustomAgentsService.getById', () => {
  test('возвращает агента когда владелец совпадает', async () => {
    const s = makeGetByIdSvc({ id: 'a1', owner_user_id: 'owner-1', name: 'X', system_prompt: 'sp' });
    const out = await s.getById('a1', 'owner-1');
    expect(out.name).toBe('X');
  });

  test('кидает NotFound когда строки нет (включая чужого владельца)', async () => {
    const s = makeGetByIdSvc(null);
    await expect(s.getById('a1', 'owner-2')).rejects.toThrow('NotFound');
  });
});
