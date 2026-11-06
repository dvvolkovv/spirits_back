import { Pool } from 'pg';

export const PG_URL = process.env.PROVISIONING_PG_URL;
export const describePg = PG_URL ? describe : describe.skip;

type CreatePrivacyPgOptions = {
  beforeCreateTable?: (context: { schema: string; pool: Pool }) => Promise<void>;
};

export async function createPrivacyPg(options: CreatePrivacyPgOptions = {}) {
  if (!PG_URL) throw new Error('PROVISIONING_PG_URL is required');

  const schema = `privacy_${process.pid}_${Date.now()}`;
  const pool = new Pool({
    connectionString: PG_URL,
    max: 4,
    options: `-c search_path=${schema}`,
  });

  let schemaCreated = false;
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    await options.beforeCreateTable?.({ schema, pool });
    await pool.query(`
      CREATE TABLE ai_profiles_consolidated (
        id serial PRIMARY KEY,
        user_id text UNIQUE NOT NULL,
        email text,
        profile_data jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  } catch (error) {
    if (schemaCreated) {
      try {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      } catch {}
    }
    try {
      await pool.end();
    } catch {}
    throw error;
  }

  const pg = {
    query: (text: string, params?: any[]) => pool.query(text, params),
  };

  return {
    pool,
    pg,
    close: async () => {
      try {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}
