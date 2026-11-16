import { readFileSync } from 'fs';
import { Pool } from 'pg';

const PG = process.env.PROVISIONING_PG_URL;

(PG ? describe : describe.skip)('account deletion schema', () => {
  it('создаёт generation и jobs, не заполняя исторический deleted', async () => {
    const pool = new Pool({ connectionString: PG });
    try {
      await pool.query(`
        CREATE TABLE user_id (
          internal_id text PRIMARY KEY,
          state text,
          update_date timestamptz DEFAULT now()
        )
      `);
      await pool.query(`INSERT INTO user_id VALUES ('u-historical', 'deleted', now())`);

      const sql = readFileSync('src/account-deletion/migrations/001_account_deletion.sql', 'utf8');
      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query('COMMIT');
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
      await pool.query(sql);

      const user = await pool.query(
        `SELECT deleted_at, deletion_id FROM user_id WHERE internal_id='u-historical'`,
      );
      expect(user.rows[0]).toEqual({ deleted_at: null, deletion_id: null });

      const deletionId = '11111111-1111-1111-1111-111111111111';
      await pool.query(
        `INSERT INTO account_deletion_jobs (deletion_id,user_id,resource_type,resource_key,phase)
         VALUES ($1,'u-1','chat-file.purge','a','purge')`,
        [deletionId],
      );
      await expect(pool.query(
        `INSERT INTO account_deletion_jobs (deletion_id,user_id,resource_type,resource_key,phase)
         VALUES ($1,'u-1','chat-file.purge','a','purge')`,
        [deletionId],
      )).rejects.toMatchObject({ code: '23505' });
    } finally {
      await pool.query('DROP TABLE IF EXISTS account_deletion_jobs, user_id').catch(() => undefined);
      await pool.end();
    }
  });
});
