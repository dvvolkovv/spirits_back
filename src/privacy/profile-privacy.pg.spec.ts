import { Pool } from 'pg';
import {
  PrivacySettingsDataError,
  automaticProfilingAllowed,
  canReceiveNewProposal,
  getPrivacySettings,
  updatePrivacySettings,
} from './profile-privacy';
import { PG_URL, createPrivacyPg, describePg } from './profile-privacy.pg-helper';

async function waitForPostgresLockWaiters(pool: Pool, pids: number[]) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT DISTINCT pid
       FROM pg_stat_activity
       WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'`,
      [pids],
    );
    if (result.rows.length === pids.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock waiters: ${pids.join(', ')}`);
}

describePg('profile privacy against an isolated PostgreSQL schema', () => {
  jest.setTimeout(20_000);

  let privacy: Awaited<ReturnType<typeof createPrivacyPg>>;

  beforeAll(async () => {
    privacy = await createPrivacyPg();
  });

  beforeEach(async () => {
    await privacy.pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, profile_data)
       VALUES ('u1', $1::jsonb), ('u2', NULL)`,
      [JSON.stringify({ keep: 'yes' })],
    );
  });

  afterEach(async () => {
    await privacy.pool.query('TRUNCATE ai_profiles_consolidated');
  });

  afterAll(async () => {
    if (privacy) await privacy.close();
  });

  it('returns true defaults for NULL profile_data', async () => {
    await expect(getPrivacySettings(privacy.pg as any, 'u2')).resolves.toEqual({
      automaticProfiling: true,
      discoverable: true,
    });
  });

  it('treats JSONB null as an empty object when updating both fields', async () => {
    await privacy.pool.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = 'null'::jsonb
       WHERE user_id = 'u1'`,
    );

    await expect(getPrivacySettings(privacy.pg as any, 'u1')).resolves.toEqual({
      automaticProfiling: true,
      discoverable: true,
    });
    await expect(updatePrivacySettings(privacy.pg as any, 'u1', {
      automaticProfiling: false,
      discoverable: false,
    })).resolves.toEqual({ automaticProfiling: false, discoverable: false });

    const result = await privacy.pool.query(
      'SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      ['u1'],
    );
    expect(result.rows[0].profile_data).toEqual({
      automaticProfiling: false,
      discoverable: false,
    });
  });

  it('does not lose concurrent independent updates or touch another user', async () => {
    await Promise.all([
      updatePrivacySettings(privacy.pg as any, 'u1', { automaticProfiling: false }),
      updatePrivacySettings(privacy.pg as any, 'u1', { discoverable: false }),
    ]);

    await expect(getPrivacySettings(privacy.pg as any, 'u1')).resolves.toEqual({
      automaticProfiling: false,
      discoverable: false,
    });
    await expect(getPrivacySettings(privacy.pg as any, 'u2')).resolves.toEqual({
      automaticProfiling: true,
      discoverable: true,
    });

    const u1 = await privacy.pool.query(
      'SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      ['u1'],
    );
    expect(u1.rows[0].profile_data).toEqual({
      keep: 'yes',
      automaticProfiling: false,
      discoverable: false,
    });

    const u2 = await privacy.pool.query(
      'SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      ['u2'],
    );
    expect(u2.rows[0].profile_data).toBeNull();
  });

  it('preserves both fields after forcing two writers to wait on the same row lock', async () => {
    const blocker = await privacy.pool.connect();
    const first = await privacy.pool.connect();
    const second = await privacy.pool.connect();
    let blockerInTransaction = false;
    let firstUpdate: Promise<unknown> | undefined;
    let secondUpdate: Promise<unknown> | undefined;

    try {
      const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      await blocker.query('BEGIN');
      blockerInTransaction = true;
      await blocker.query(
        'SELECT id FROM ai_profiles_consolidated WHERE user_id = $1 FOR UPDATE',
        ['u1'],
      );

      firstUpdate = updatePrivacySettings(
        { query: (sql: string, params?: any[]) => first.query(sql, params) } as any,
        'u1',
        { automaticProfiling: false },
      );
      secondUpdate = updatePrivacySettings(
        { query: (sql: string, params?: any[]) => second.query(sql, params) } as any,
        'u1',
        { discoverable: false },
      );
      const bothUpdates = Promise.all([firstUpdate, secondUpdate]);
      void bothUpdates.catch(() => {});

      // Neither writer can finish before this barrier. A future SELECT-then-UPDATE
      // implementation reads the same pre-update JSON on both clients before its
      // writers block, so releasing the lock deterministically exposes lost updates.
      await waitForPostgresLockWaiters(privacy.pool, [firstPid, secondPid]);
      await blocker.query('COMMIT');
      blockerInTransaction = false;
      await bothUpdates;

      await expect(getPrivacySettings(privacy.pg as any, 'u1')).resolves.toEqual({
        automaticProfiling: false,
        discoverable: false,
      });
      const result = await privacy.pool.query(
        'SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
        ['u1'],
      );
      expect(result.rows[0].profile_data).toEqual({
        keep: 'yes',
        automaticProfiling: false,
        discoverable: false,
      });
    } finally {
      if (blockerInTransaction) {
        await blocker.query('ROLLBACK').catch(() => {});
      }
      if (firstUpdate && secondUpdate) {
        await Promise.allSettled([firstUpdate, secondUpdate]);
      }
      blocker.release();
      first.release();
      second.release();
    }
  });

  it('updates both fields in one call and preserves unrelated JSON', async () => {
    await expect(updatePrivacySettings(privacy.pg as any, 'u1', {
      automaticProfiling: false,
      discoverable: false,
    })).resolves.toEqual({ automaticProfiling: false, discoverable: false });

    const result = await privacy.pool.query(
      'SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      ['u1'],
    );
    expect(result.rows[0].profile_data).toEqual({
      keep: 'yes',
      automaticProfiling: false,
      discoverable: false,
    });
  });

  it('updates one field without changing the other default', async () => {
    await expect(updatePrivacySettings(privacy.pg as any, 'u1', {
      automaticProfiling: false,
    })).resolves.toEqual({ automaticProfiling: false, discoverable: true });
  });

  it('cleans only its schema and preserves the original error when CREATE TABLE fails', async () => {
    const inspector = new Pool({ connectionString: PG_URL, max: 1 });
    let schema = '';
    let setupPool: Pool | undefined;
    let originalError: unknown;

    try {
      const setup = createPrivacyPg({
        beforeCreateTable: async (context) => {
          schema = context.schema;
          setupPool = context.pool;
          try {
            await context.pool.query('CREATE TABLE forced_setup_failure (');
          } catch (error) {
            originalError = error;
            throw error;
          }
        },
      });
      const receivedError = await setup.then(
        () => { throw new Error('Setup unexpectedly succeeded'); },
        (error) => error,
      );

      expect(receivedError).toBe(originalError);
      expect(schema).not.toBe('');
      const schemaCheck = await inspector.query(
        'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists',
        [schema],
      );
      expect(schemaCheck.rows[0].exists).toBe(false);
      await expect(setupPool!.query('SELECT 1')).rejects.toThrow();
    } finally {
      if (schema) await inspector.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await inspector.end();
    }
  });

  it('fails closed when stored privacy data is malformed', async () => {
    await privacy.pool.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = $1::jsonb
       WHERE user_id = 'u1'`,
      [JSON.stringify({ automaticProfiling: 'false', discoverable: true })],
    );

    await expect(getPrivacySettings(privacy.pg as any, 'u1')).rejects.toBeInstanceOf(
      PrivacySettingsDataError,
    );
    await expect(automaticProfilingAllowed(privacy.pg as any, 'u1')).resolves.toBe(false);
    await expect(canReceiveNewProposal(privacy.pg as any, 'u1')).resolves.toBe(false);
  });
});
