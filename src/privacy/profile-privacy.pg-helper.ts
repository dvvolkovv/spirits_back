import { Pool } from 'pg';

export const PG_URL = process.env.PROVISIONING_PG_URL;
export const describePg = PG_URL ? describe : describe.skip;

export async function createPrivacyPg() {
  if (!PG_URL) throw new Error('PROVISIONING_PG_URL is required');

  const schema = `privacy_${process.pid}_${Date.now()}`;
  const pool = new Pool({
    connectionString: PG_URL,
    max: 4,
    options: `-c search_path=${schema}`,
  });

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
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
    await pool.end();
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
