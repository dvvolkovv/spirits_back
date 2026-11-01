import { Pool } from 'pg';
import { AgentVersionsService } from './agent-versions.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `agent_versions_spec_${process.pid}`;

maybe('agent versions bootstrap against real PostgreSQL', () => {
  jest.setTimeout(15_000);

  let admin: Pool;
  let pool: Pool;

  function makeService() {
    const pg = {
      query: (sql: string, params?: any[]) => pool.query(sql, params),
      getClient: () => pool.connect(),
    };
    return new AgentVersionsService(pg as any, {} as any);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({
      connectionString: PG,
      max: 4,
      options: `-c search_path=${SCHEMA}`,
    });
  });

  beforeEach(async () => {
    await pool.query('DROP TABLE IF EXISTS agent_versions');
    await pool.query('DROP TABLE IF EXISTS agents');
    await pool.query(
      'CREATE TABLE agents (id integer PRIMARY KEY, description text, system_prompt text)',
    );
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('backfills NULL fields and supports repeat execution', async () => {
    await pool.query(
      'INSERT INTO agents (id, description, system_prompt) VALUES (12, NULL, NULL)',
    );
    const service = makeService();

    await service.onModuleInit();
    await service.onModuleInit();

    const result = await pool.query(
      `SELECT agent_id, version, description, system_prompt, status
       FROM agent_versions`,
    );
    expect(result.rows).toEqual([
      {
        agent_id: 12,
        version: 1,
        description: '',
        system_prompt: '',
        status: 'published',
      },
    ]);
  });

  it('supports two concurrent bootstraps without duplicate versions', async () => {
    await pool.query(
      "INSERT INTO agents (id, description, system_prompt) VALUES (12, 'old', 'live')",
    );

    await Promise.all([
      makeService().onModuleInit(),
      makeService().onModuleInit(),
    ]);

    const result = await pool.query(
      `SELECT count(*)::int AS count, min(description) AS description,
              min(system_prompt) AS system_prompt
       FROM agent_versions WHERE agent_id = 12 AND version = 1`,
    );
    expect(result.rows).toEqual([
      { count: 1, description: 'old', system_prompt: 'live' },
    ]);
  });
});
