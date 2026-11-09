import { Pool } from 'pg';
import { RetentionUnsubscribeService } from './retention-unsubscribe.service';
import { cleanupOrphanRetentionTokens } from './retention-token-cleanup';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `retention_token_cleanup_spec_${process.pid}`;

maybe('очистка осиротевших retention-токенов против живого PostgreSQL', () => {
  jest.setTimeout(20_000);

  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({
      connectionString: PG,
      max: 4,
      options: `-c search_path=${SCHEMA}`,
    });
    await new RetentionUnsubscribeService(pool as any).onModuleInit();
    await pool.query(`
      CREATE TABLE ai_profiles_consolidated (user_id text PRIMARY KEY, email text);
      CREATE TABLE user_id (internal_id text PRIMARY KEY, primary_email text);
      CREATE TABLE user_identities (user_id text, email text);
    `);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE retention_email_unsubscribes, ai_profiles_consolidated,
               user_id, user_identities;
    `);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('удаляет только невостребованные token-only строки без suppression', async () => {
    for (const email of [
      'orphan@example.com',
      'profile-referenced@example.com',
      'primary-referenced@example.com',
      'identity-referenced@example.com',
      'shared@example.com',
    ]) {
      await pool.query(
        'INSERT INTO retention_email_unsubscribes (email_normalized, token) VALUES ($1, $2)',
        [email, `${email}-token`],
      );
    }
    await pool.query(
      `INSERT INTO retention_email_unsubscribes (email_normalized, token, unsubscribed_at)
       VALUES ('suppressed@example.com', 'suppressed-token', now())`,
    );
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, email) VALUES
        ('profile-user', ' Profile-Referenced@Example.com '),
        ('shared-a', ' Shared@Example.com '),
        ('shared-b', 'shared@example.com')`,
    );
    await pool.query(
      `INSERT INTO user_id (internal_id, primary_email)
       VALUES ('primary-user', ' Primary-Referenced@Example.com ')`,
    );
    await pool.query(
      `INSERT INTO user_identities (user_id, email)
       VALUES ('identity-user', ' Identity-Referenced@Example.com ')`,
    );
    await pool.query("DELETE FROM ai_profiles_consolidated WHERE user_id='shared-a'");

    await cleanupOrphanRetentionTokens(pool as any);

    let remaining = await pool.query(
      'SELECT email_normalized FROM retention_email_unsubscribes ORDER BY email_normalized',
    );
    expect(remaining.rows.map((r) => r.email_normalized)).toEqual([
      'identity-referenced@example.com',
      'primary-referenced@example.com',
      'profile-referenced@example.com',
      'shared@example.com',
      'suppressed@example.com',
    ]);

    await pool.query("DELETE FROM ai_profiles_consolidated WHERE user_id='shared-b'");
    await cleanupOrphanRetentionTokens(pool as any);
    remaining = await pool.query(
      'SELECT email_normalized FROM retention_email_unsubscribes ORDER BY email_normalized',
    );
    expect(remaining.rows.map((r) => r.email_normalized)).toEqual([
      'identity-referenced@example.com',
      'primary-referenced@example.com',
      'profile-referenced@example.com',
      'suppressed@example.com',
    ]);
  });
});
