import { Pool } from 'pg';
import { PgService } from './pg.service';

const CONNECTION_STRING = process.env.PROVISIONING_PG_URL;
const maybe = CONNECTION_STRING ? describe : describe.skip;

maybe('PgService cancellation against real PostgreSQL', () => {
  jest.setTimeout(20_000);
  let service: PgService;
  let observer: Pool;
  let previousDatabaseUrl: string | undefined;

  beforeAll(() => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = CONNECTION_STRING;
    service = new PgService();
    service.onModuleInit();
    observer = new Pool({ connectionString: CONNECTION_STRING, max: 1 });
  });

  afterAll(async () => {
    await Promise.all([service.onModuleDestroy(), observer.end()]);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (value !== null) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('timed out waiting for PostgreSQL state');
  }

  it('abort реально останавливает pg_sleep на сервере и освобождает клиента', async () => {
    const marker = `alert_bot_cancel_${process.pid}_${Date.now()}`;
    const controller = new AbortController();
    const running = service.query(`/* ${marker} */ SELECT pg_sleep(10)`, [], controller.signal);
    const rejection = expect(running).rejects.toThrow();

    const activity = await waitFor(async () => {
      const r = await observer.query(
        `SELECT pid FROM pg_stat_activity
          WHERE query LIKE $1 AND state = 'active' AND pid <> pg_backend_pid()
          LIMIT 1`,
        [`%${marker}%`],
      );
      return r.rows[0] ?? null;
    });
    expect(activity.pid).toEqual(expect.any(Number));

    controller.abort();
    await rejection;

    await waitFor(async () => {
      const r = await observer.query(
        `SELECT 1 AS present FROM pg_stat_activity
          WHERE query LIKE $1 AND state = 'active' AND pid <> pg_backend_pid() LIMIT 1`,
        [`%${marker}%`],
      );
      return r.rowCount === 0 ? true : null;
    });

    // Если release не выполнен, выделенное соединение не вернулось в основной пул.
    await expect(service.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });
});
