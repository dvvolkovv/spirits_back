import { ConflictException } from '@nestjs/common';
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

  it('bootstraps when legacy agents has no unique constraint', async () => {
    await pool.query('DROP TABLE agents');
    await pool.query(
      'CREATE TABLE agents (id integer, description text, system_prompt text)',
    );
    await pool.query(
      "INSERT INTO agents (id, description, system_prompt) VALUES (12, 'old', 'live')",
    );

    await makeService().onModuleInit();

    const result = await pool.query(
      'SELECT agent_id, version, status FROM agent_versions',
    );
    expect(result.rows).toEqual([{ agent_id: 12, version: 1, status: 'published' }]);
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

  it('allows only one concurrent publication when no live version exists', async () => {
    await pool.query(
      "INSERT INTO agents (id, description, system_prompt) VALUES (12, 'old', 'live')",
    );
    const service = makeService();
    await service.onModuleInit();
    const live = await service.latest(12);
    if (!live) throw new Error('Expected bootstrapped live version');
    const first = await service.createDraft('first', 12, {
      description: 'first description',
      system_prompt: 'first prompt',
      base_version_id: live.id,
    });
    const second = await service.createDraft('second', 12, {
      description: 'second description',
      system_prompt: 'second prompt',
      base_version_id: first.id,
    });
    await pool.query(
      "UPDATE agent_versions SET status = 'superseded' WHERE id = $1",
      [live.id],
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION delay_agent_version_publish()
      RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.15);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER delay_publish
      BEFORE UPDATE ON agent_versions
      FOR EACH ROW
      WHEN (NEW.status = 'published')
      EXECUTE FUNCTION delay_agent_version_publish();
    `);

    const results = await Promise.allSettled([
      makeService().publish('first', 12, first.id, null),
      makeService().publish('second', 12, second.id, null),
    ]);

    const successful = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);
    if (successful[0]?.status !== 'fulfilled' || failed[0]?.status !== 'rejected') {
      throw new Error('Expected one fulfilled and one rejected publication');
    }
    expect(failed[0].reason).toBeInstanceOf(ConflictException);
    expect(failed[0].reason.getStatus()).toBe(409);
    expect(failed[0].reason.code).toBeUndefined();

    const versions = await pool.query(
      `SELECT status, count(*)::int AS count
       FROM agent_versions GROUP BY status ORDER BY status`,
    );
    expect(versions.rows).toEqual([
      { status: 'draft', count: 1 },
      { status: 'published', count: 1 },
      { status: 'superseded', count: 1 },
    ]);
    const agent = await pool.query(
      'SELECT description, system_prompt FROM agents WHERE id = 12',
    );
    expect(agent.rows[0]).toEqual({
      description: successful[0].value.description,
      system_prompt: successful[0].value.system_prompt,
    });
  });
});
