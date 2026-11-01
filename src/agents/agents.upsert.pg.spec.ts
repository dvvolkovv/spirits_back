import { Pool } from 'pg';
import { AgentVersionsService } from './agent-versions.service';
import { AgentsService } from './agents.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `agents_upsert_spec_${process.pid}`;

maybe('legacy agent upsert against real PostgreSQL', () => {
  jest.setTimeout(20_000);

  let admin: Pool;
  let pool: Pool;

  function makeService(afterQuery?: (sql: string) => Promise<void>) {
    const pg = {
      query: async (sql: string, params?: any[]) => {
        const result = await pool.query(sql, params);
        if (afterQuery) await afterQuery(sql);
        return result;
      },
      getClient: () => pool.connect(),
    };
    const versions = new AgentVersionsService(pg as any, {} as any);
    return { agents: new AgentsService(pg as any, versions), versions };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({
      connectionString: PG,
      max: 6,
      options: `-c search_path=${SCHEMA}`,
    });
  });

  beforeEach(async () => {
    await pool.query('DROP TABLE IF EXISTS agent_versions CASCADE');
    await pool.query('DROP TABLE IF EXISTS agents CASCADE');
    await pool.query('DROP SEQUENCE IF EXISTS agents_id_seq CASCADE');
    await pool.query('CREATE SEQUENCE agents_id_seq');
    await pool.query(`
      CREATE TABLE agents (
        id integer PRIMARY KEY DEFAULT nextval('agents_id_seq'),
        name text NOT NULL UNIQUE,
        description text,
        system_prompt text
      )
    `);
    await pool.query('ALTER SEQUENCE agents_id_seq OWNED BY agents.id');
    const { versions } = makeService();
    await versions.onModuleInit();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('rolls back a failed v1 insert and successfully retries the same creation', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_legacy_version_insert()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced version failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_legacy_version
      BEFORE INSERT ON agent_versions
      FOR EACH ROW EXECUTE FUNCTION fail_legacy_version_insert();
    `);
    const { agents } = makeService();
    const data = {
      id: 100,
      name: 'atomic-agent',
      system_prompt: 'prompt',
      description: 'description',
    };

    await expect(agents.upsertAgent(data, 'admin-1')).rejects.toThrow('forced version failure');
    const afterFailure = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM agents WHERE name = 'atomic-agent') AS agents,
        (SELECT count(*)::int FROM agent_versions WHERE agent_id = 100) AS versions
    `);
    expect(afterFailure.rows[0]).toEqual({ agents: 0, versions: 0 });

    await pool.query('DROP TRIGGER fail_legacy_version ON agent_versions');
    await expect(agents.upsertAgent(data, 'admin-1')).resolves.toMatchObject({ id: 100 });
    const afterRetry = await pool.query(`
      SELECT a.id, v.version, v.status, v.created_by, v.published_by
      FROM agents a JOIN agent_versions v ON v.agent_id = a.id
      WHERE a.name = 'atomic-agent'
    `);
    expect(afterRetry.rows).toEqual([{
      id: 100,
      version: 1,
      status: 'published',
      created_by: 'admin-1',
      published_by: 'admin-1',
    }]);
  });

  it('serializes concurrent creates of the same new name without unique errors', async () => {
    let lookups = 0;
    let releaseLookups!: () => void;
    const bothLookedUp = new Promise<void>((resolve) => (releaseLookups = resolve));
    const afterQuery = async (sql: string) => {
      if (!/FROM agents WHERE name = \$1/i.test(sql)) return;
      lookups += 1;
      if (lookups === 2) releaseLookups();
      await bothLookedUp;
    };
    const first = makeService(afterQuery).agents;
    const second = makeService(afterQuery).agents;

    const results = await Promise.all([
      first.upsertAgent({ name: 'shared-agent', system_prompt: 'first', description: 'first' }, 'first-admin'),
      second.upsertAgent({ name: 'shared-agent', system_prompt: 'second', description: 'second' }, 'second-admin'),
    ]);

    expect(results[0].id).toBe(results[1].id);
    const state = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM agents WHERE name = 'shared-agent') AS agents,
        (SELECT count(*)::int FROM agent_versions v JOIN agents a ON a.id = v.agent_id
          WHERE a.name = 'shared-agent') AS versions,
        (SELECT count(*)::int FROM agent_versions v JOIN agents a ON a.id = v.agent_id
          WHERE a.name = 'shared-agent' AND v.version = 1 AND v.status = 'superseded') AS v1,
        (SELECT count(*)::int FROM agent_versions v JOIN agents a ON a.id = v.agent_id
          WHERE a.name = 'shared-agent' AND v.status = 'published') AS published
    `);
    expect(state.rows[0]).toEqual({ agents: 1, versions: 2, v1: 1, published: 1 });
  });

  it('advances the id sequence after an explicit-id creation', async () => {
    const { agents } = makeService();

    await agents.upsertAgent({ id: 500, name: 'explicit-id', system_prompt: 'prompt' }, 'admin-1');
    const automatic = await agents.upsertAgent({ name: 'automatic-id', system_prompt: 'prompt' }, 'admin-1');

    expect(automatic.id).toBeGreaterThan(500);
    const versions = await pool.query(
      'SELECT version, status FROM agent_versions WHERE agent_id = $1',
      [automatic.id],
    );
    expect(versions.rows).toEqual([{ version: 1, status: 'published' }]);
  });
});
