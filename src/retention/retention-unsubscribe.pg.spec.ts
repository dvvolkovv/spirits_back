import { Pool } from 'pg';
import { RetentionUnsubscribeService } from './retention-unsubscribe.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `retention_unsubscribe_spec_${process.pid}`;
const SECRET = '44'.repeat(32);
const ORIGINAL_SECRET = process.env.RETENTION_UNSUBSCRIBE_SECRET;

maybe('stateless-отписка retention против живого PostgreSQL', () => {
  jest.setTimeout(20_000);

  let admin: Pool;
  let pool: Pool;
  let svc: RetentionUnsubscribeService;

  beforeAll(async () => {
    process.env.RETENTION_UNSUBSCRIBE_SECRET = SECRET;
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({
      connectionString: PG,
      max: 12,
      options: `-c search_path=${SCHEMA}`,
    });
    svc = new RetentionUnsubscribeService(pool as any);
    await svc.onModuleInit();
    await svc.onModuleInit();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE retention_email_unsubscribes');
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
    if (ORIGINAL_SECRET === undefined) delete process.env.RETENTION_UNSUBSCRIBE_SECRET;
    else process.env.RETENTION_UNSUBSCRIBE_SECRET = ORIGINAL_SECRET;
  });

  it('создаёт таблицу стартовой миграцией и допускает повторный запуск', async () => {
    const r = await pool.query(
      `SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema=$1 AND table_name='retention_email_unsubscribes'`,
      [SCHEMA],
    );
    expect(r.rows[0].count).toBe(1);
  });

  it('8 конкурентных ensureToken дают 8 токенов, ноль строк и один email', async () => {
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => svc.ensureToken(' User@Example.com ')),
    );
    expect(new Set(tokens).size).toBe(8);
    let r = await pool.query('SELECT count(*)::int AS count FROM retention_email_unsubscribes');
    expect(r.rows[0].count).toBe(0);
    for (const token of tokens) {
      await expect(svc.findByToken(token)).resolves.toEqual({
        email: 'user@example.com', unsubscribedAt: null,
      });
    }
    r = await pool.query('SELECT count(*)::int AS count FROM retention_email_unsubscribes');
    expect(r.rows[0].count).toBe(0);
  });

  it('первая отписка создаёт одну строку и переключает suppression false→true', async () => {
    const token = await svc.ensureToken('person@example.com');
    await expect(svc.isUnsubscribed(' Person@Example.com ')).resolves.toBe(false);
    const first = await svc.unsubscribe(token);
    expect(first?.email).toBe('person@example.com');
    expect(first?.unsubscribedAt).not.toBeNull();
    await expect(svc.isUnsubscribed(' Person@Example.com ')).resolves.toBe(true);
    const r = await pool.query('SELECT count(*)::int AS count FROM retention_email_unsubscribes');
    expect(r.rows[0].count).toBe(1);
  });

  it('другой токен сохраняет первое время, старый токен остаётся валидным', async () => {
    const oldToken = await svc.ensureToken('first-time@example.com');
    const newToken = await svc.ensureToken('first-time@example.com');
    expect(newToken).not.toBe(oldToken);
    const first = await svc.unsubscribe(oldToken);
    const second = await svc.unsubscribe(newToken);
    expect(first?.unsubscribedAt).toBeDefined();
    expect(first?.unsubscribedAt).not.toBeNull();
    expect(second?.unsubscribedAt?.getTime()).toBe(first?.unsubscribedAt?.getTime());
    await expect(svc.findByToken(oldToken)).resolves.toEqual({
      email: 'first-time@example.com', unsubscribedAt: first?.unsubscribedAt,
    });
    await expect(svc.findByToken(newToken)).resolves.toEqual({
      email: 'first-time@example.com', unsubscribedAt: first?.unsubscribedAt,
    });
    const r = await pool.query('SELECT count(*)::int AS count FROM retention_email_unsubscribes');
    expect(r.rows[0].count).toBe(1);
  });

  it('неизвестный и tampered токены возвращают null без создания строк', async () => {
    const unknown = 'q'.repeat(43);
    const token = await svc.ensureToken('tamper@example.com');
    const tampered = Buffer.from(token, 'base64url');
    tampered[tampered.length - 1] ^= 1;
    await expect(svc.findByToken(unknown)).resolves.toBeNull();
    await expect(svc.unsubscribe(unknown)).resolves.toBeNull();
    await expect(svc.findByToken(tampered.toString('base64url'))).resolves.toBeNull();
    const r = await pool.query('SELECT count(*)::int AS count FROM retention_email_unsubscribes');
    expect(r.rows[0].count).toBe(0);
  });
});
