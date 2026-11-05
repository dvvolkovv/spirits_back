import { PgService } from './pg.service';

const CONNECTION_STRING = process.env.PROVISIONING_PG_URL;
if (!CONNECTION_STRING) throw new Error('PROVISIONING_PG_URL is required for pg.shutdown.real.spec.ts');

describe('PgService shutdown with a real hanging advisory lock', () => {
  jest.setTimeout(10_000);

  it('force-release checked out clients завершает pool.end при зависшем lock wait', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = CONNECTION_STRING;
    const service = new PgService();
    service.onModuleInit();
    const key = 741852963;
    const blocker = await service.getClient();
    const waiter = await service.getClient();
    await blocker.query('SELECT pg_advisory_lock($1)', [key]);
    const waiting = waiter.query('SELECT pg_advisory_lock($1)', [key]).then(
      () => ({ status: 'acquired' }),
      (error) => ({ status: 'rejected', error }),
    );
    const events: string[] = [];
    service.registerPreCloseHook(async () => { events.push('admission.ops.stop'); });

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const startedAt = Date.now();
      const closing = service.onModuleDestroy();
      const outcome = await Promise.race([
        closing.then(() => 'closed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2000)),
      ]);

      expect(outcome).toBe('closed');
      expect(Date.now() - startedAt).toBeLessThan(6500);
      expect(events).toEqual(['admission.ops.stop']);
      expect((await waiting).status).toBe('rejected');
    } finally {
      blocker.release(true);
      waiter.release(true);
      await service.onModuleDestroy().catch(() => undefined);
      await waiting;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });
});
