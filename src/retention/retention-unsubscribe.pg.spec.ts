import { Pool } from 'pg';
import { RetentionUnsubscribeService } from './retention-unsubscribe.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `retention_unsubscribe_spec_${process.pid}`;

maybe('отписка retention против живого PostgreSQL', () => {
  jest.setTimeout(20_000);

  let admin: Pool;
  let pool: Pool;
  let svc: RetentionUnsubscribeService;

  beforeAll(async () => {
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
  });

  it('создаёт таблицу стартовой миграцией и допускает повторный запуск', async () => {
    const r = await pool.query(
      `SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema=$1 AND table_name='retention_email_unsubscribes'`,
      [SCHEMA],
    );
    expect(r.rows[0].count).toBe(1);
  });

  it('8 конкурентных ensureToken возвращают один токен и оставляют одну строку', async () => {
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => svc.ensureToken(' User@Example.com ')),
    );
    expect(new Set(tokens).size).toBe(1);
    const r = await pool.query(
      'SELECT email_normalized, token FROM retention_email_unsubscribes',
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].email_normalized).toBe('user@example.com');
    expect(r.rows[0].token).toBe(tokens[0]);
  });

  it('suppression выключен до отписки и включен после неё', async () => {
    const token = await svc.ensureToken('person@example.com');
    await expect(svc.isUnsubscribed(' Person@Example.com ')).resolves.toBe(false);
    await svc.unsubscribe(token);
    await expect(svc.isUnsubscribed(' Person@Example.com ')).resolves.toBe(true);
  });

  it('две отписки сохраняют точное первое unsubscribedAt', async () => {
    const token = await svc.ensureToken('first-time@example.com');
    const first = await svc.unsubscribe(token);
    const second = await svc.unsubscribe(token);
    expect(first?.unsubscribedAt).not.toBeNull();
    expect(second?.unsubscribedAt).toEqual(first?.unsubscribedAt);
  });

  it('неизвестный валидный 43-символьный токен возвращает null', async () => {
    const token = 'q'.repeat(43);
    await expect(svc.findByToken(token)).resolves.toBeNull();
    await expect(svc.unsubscribe(token)).resolves.toBeNull();
  });
});
