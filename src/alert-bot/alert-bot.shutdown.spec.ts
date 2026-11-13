import { EventEmitter } from 'events';
import { PgService } from '../common/services/pg.service';
import { AlertBotLifecycle } from './alert-bot.lifecycle';
import { AlertBotOpsServer } from './alert-bot.ops-server';

describe('alert-bot shutdown before PostgreSQL close', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('bounded drain abort-ит hanging tool до pool.end и не ждёт Claude бесконечно', async () => {
    delete process.env.ALERT_BOT_WEBHOOK_URL;
    delete process.env.ALERT_BOT_WEBHOOK_SECRET;
    const events: string[] = [];
    const pg = new PgService();
    const pool = { end: jest.fn(async () => { events.push('pool.end'); }) };
    const lockPool = { end: jest.fn(async () => { events.push('lockPool.end'); }) };
    (pg as any).pool = pool;
    (pg as any).lockPool = lockPool;

    let toolSignal: AbortSignal | undefined;
    const tools = {
      definitions: jest.fn().mockReturnValue([]),
      execute: jest.fn((_name, _args, _identity, signal: AbortSignal) => {
        toolSignal = signal;
        signal.addEventListener('abort', () => { events.push('tool.abort'); }, { once: true });
        return new Promise<string>(() => {});
      }),
    };
    const ops = new AlertBotOpsServer({} as any, tools as any, {} as any, {} as any, { toolTimeoutMs: 60_000 });
    const turns = {
      idle: jest.fn(() => {
        events.push('turns.idle');
        return new Promise<void>(() => {});
      }),
    };
    const service = {
      stopAdmission: jest.fn(() => { events.push('admission.stop'); }),
      retryFailedUpdates: jest.fn(),
    };
    const store = {
      migrate: jest.fn().mockResolvedValue(undefined),
      interruptInProgress: jest.fn(),
      requeueProcessingUpdates: jest.fn(),
      cleanup: jest.fn(),
    };
    const lifecycle = new (AlertBotLifecycle as any)(
      store, ops, {}, turns, service, pg,
    );
    (lifecycle as any).repairStore = { migrate: jest.fn().mockResolvedValue(undefined) };
    await lifecycle.onModuleInit();

    const req = new EventEmitter();
    const res = new EventEmitter();
    const tool = (ops as any).executeWithDeadline('hanging', {}, { adminUserId: 'admin' }, req, res);
    await Promise.resolve();
    expect(tools.execute).toHaveBeenCalledTimes(1);

    const startedAt = Date.now();
    try {
      await pg.onModuleDestroy();
      expect(Date.now() - startedAt).toBeLessThan(6500);
      expect(service.stopAdmission).toHaveBeenCalledTimes(1);
      expect(toolSignal?.aborted).toBe(true);
      expect(events).toEqual([
        'admission.stop', 'turns.idle', 'tool.abort', 'pool.end', 'lockPool.end',
      ]);
      await expect(tool).resolves.toBe(JSON.stringify({ error: 'tool_failed' }));
      expect(pool.end).toHaveBeenCalledTimes(1);
      expect(lockPool.end).toHaveBeenCalledTimes(1);
    } finally {
      await ops.stop();
      await lifecycle.onModuleDestroy();
    }
  }, 8000);
});
