import { Pool } from 'pg';
import { AdminService } from './admin.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `admin_active_hours_spec_${process.pid}`;

maybe('AdminService active users hourly buckets against PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  let service: AdminService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 2, options: `-c search_path=${SCHEMA}` });
    await pool.query(`
      CREATE TABLE token_transactions (
        id bigserial PRIMARY KEY,
        user_id text NOT NULL,
        amount bigint NOT NULL,
        transaction_type text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ai_profiles_consolidated (
        user_id text PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    service = Object.create(AdminService.prototype);
    (service as any).pg = pool;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it.each([
    [1, 24],
    [7, 168],
  ])('days=%i hour mode возвращает %i различных часовых bucket', async (days, count) => {
    const result = await service.getActiveUsersStats({ days, bucket: 'hour' });

    expect(result.bucket).toBe('hour');
    expect(result.series).toHaveLength(count);
    expect(new Set(result.series.map((row) => String(row.day))).size).toBe(count);
    const buckets = result.series.map((row) => new Date(row.day).getTime());
    expect(buckets.every((value) => Number.isFinite(value))).toBe(true);
    expect(buckets.slice(1).every((value, index) => value - buckets[index] === 3_600_000)).toBe(true);
  });
});
