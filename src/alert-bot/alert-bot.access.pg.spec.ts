import { Pool } from 'pg';
import { AlertBotAccess } from './alert-bot.access';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `alert_bot_access_spec_${process.pid}`;
const ADMIN_UUID = '11111111-1111-4111-8111-111111111111';

maybe('доступ бота алертов против живого Postgres', () => {
  jest.setTimeout(30_000);

  let admin: Pool;
  let pool: Pool;
  let access: AlertBotAccess;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(`CREATE TABLE ai_profiles_consolidated (
      user_id text PRIMARY KEY,
      isadmin boolean NOT NULL DEFAULT false)`);
    await pool.query(`CREATE TABLE tg_user_identities (
      linkeon_user_id text NOT NULL,
      tg_user_id bigint NOT NULL UNIQUE)`);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE tg_user_identities, ai_profiles_consolidated');
    await pool.query(`INSERT INTO ai_profiles_consolidated (user_id, isadmin) VALUES
      ('u-admin', true), ('u-user', false), ('${ADMIN_UUID}', true)`);
    await pool.query(`INSERT INTO tg_user_identities (linkeon_user_id, tg_user_id) VALUES
      ('u-admin', 900000000001), ('u-user', 900000000002), ('${ADMIN_UUID}', 900000000003)`);
    access = new AlertBotAccess({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('находит админа и не-админа, непривязанный Telegram не даёт аккаунт', async () => {
    // Строковый параметр сравнивается с bigint-колонкой без приведения user_id к числу.
    expect(await access.resolveTelegram('900000000001')).toEqual({ userId: 'u-admin', isAdmin: true });
    expect(await access.resolveTelegram('900000000002')).toEqual({ userId: 'u-user', isAdmin: false });
    expect(await access.resolveTelegram('900000000099')).toEqual({ userId: null, isAdmin: false });
  });

  it('поддерживает UUID аккаунта и проверяет isAdminUserId', async () => {
    expect(await access.resolveTelegram('900000000003')).toEqual({ userId: ADMIN_UUID, isAdmin: true });
    expect(await access.isAdminUserId(ADMIN_UUID)).toBe(true);
    expect(await access.isAdminUserId('u-user')).toBe(false);
    expect(await access.isAdminUserId('u-unlinked')).toBe(false);
  });
});
