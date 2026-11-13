import { Pool, PoolClient } from 'pg';
import * as childProcess from 'child_process';
import { queryWithCancellation } from '../common/services/pg-cancellation';
import { AlertBotRepairExecutor } from './alert-bot.repair-executor';
import { AlertBotRepairJobs } from './alert-bot.repair-jobs';
import { AlertBotStore } from './alert-bot.store';
import {
  CreateRepairJobInput,
  RepairIdentityGuard,
  RepairStore,
} from './alert-bot.repair-store';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `alert_repair_spec_${process.pid}`;
const TURN_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_TURN_ID = '00000000-0000-4000-8000-000000000003';
const MISSING_ID = '00000000-0000-4000-8000-000000000099';

async function boundedEnteredForTest(entered: Promise<void>, timeoutMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const reached = await Promise.race([
      entered.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    if (!reached) throw new Error('request_cancel_not_entered');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedStoppedForCleanup(stopped: Promise<void> | undefined, timeoutMs = 5_000): Promise<void> {
  if (!stopped) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      stopped.catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function forceReleaseForCleanup(client: PoolClient | undefined): void {
  // Повторный release уже возвращённого client не должен заменить исходный assertion.
  try { client?.release(true); } catch { /* client уже возвращён в pool */ }
}

maybe('durable repair store против PostgreSQL', () => {
  jest.setTimeout(30_000);
  let admin: Pool;
  let pool: Pool;
  let store: RepairStore;
  let nextUpdateId = 20_000;

  const repairInput = (chatId: string) => ({
    updateId: nextUpdateId++,
    chatId,
    adminTgId: `admin-${chatId}`,
    instruction: `Почини ${chatId}`,
  });

  const admit = async (chatId: string): Promise<string> => {
    const admission = await store.admitRepair(repairInput(chatId));
    if (admission.status !== 'accepted') throw new Error(`repair not accepted: ${admission.status}`);
    return admission.repairId;
  };

  const jobInput = (repairId: string, overrides: Partial<CreateRepairJobInput> = {}): CreateRepairJobInput => ({
    repairId,
    host: 'prod',
    command: 'systemctl restart demo',
    kind: 'exec',
    mutates: true,
    interruptible: false,
    timeoutMs: 5_000,
    ...overrides,
  });

  const guard = (repairId: string, chatId: string, overrides: Partial<RepairIdentityGuard> = {}): RepairIdentityGuard => ({
    repairId,
    turnId: TURN_ID,
    chatId,
    adminTgId: `admin-${chatId}`,
    ...overrides,
  });

  const waitForFinishLock = async (): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT pid FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'
           AND query LIKE '%alert_bot_repair_jobs%' AND query LIKE '%cancel_requested%'
         LIMIT 1`,
      );
      if (result.rows[0]) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('finish_unknown_lock_timeout');
  };

  const storeWithRepairBarrier = (onRepairLocked: () => Promise<void>): RepairStore => {
    let gated = false;
    const pg = {
      query: (text: string, params?: any[]) => pool.query(text, params),
      getClient: async () => {
        const client = await pool.connect();
        const originalQuery = client.query.bind(client);
        const originalRelease = client.release.bind(client);
        client.query = (async (text: string, ...args: any[]) => {
          const result = await (originalQuery as any)(text, ...args);
          if (!gated && text.includes('SELECT r.id FROM alert_bot_repairs r')) {
            gated = true;
            await onRepairLocked();
          }
          return result;
        }) as any;
        client.release = ((destroy?: boolean | Error) => {
          client.query = originalQuery as any;
          client.release = originalRelease;
          originalRelease(destroy);
        }) as any;
        return client;
      },
    };
    return new RepairStore(pg as any);
  };

  const expectUnknownStart = async (repairId: string, chatId: string): Promise<void> => {
    const executor = new AlertBotRepairExecutor(store);
    const jobs = new AlertBotRepairJobs(store, executor);
    const spawn = jest.spyOn(childProcess, 'spawn');
    try {
      await expect(jobs.start({
        ...guard(repairId, chatId), scope: 'repair', adminUserId: 'admin-user',
      }, 'exec', { host: 'prod', command: 'printf must-not-run' })).rejects.toThrow('repair_outcome_unknown');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      await executor.stopAll();
    }
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 8, options: `-c search_path=${SCHEMA}` });
    const pg = {
      query: (text: string, params?: any[]) => pool.query(text, params),
      getClient: () => pool.connect(),
    } as any;
    const baseStore = new AlertBotStore(pg);
    await baseStore.migrate();
    store = new RepairStore(pg);
    await store.migrate();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM alert_bot_repairs');
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('повторная и одновременная миграция безопасна', async () => {
    await expect(Promise.all([store.migrate(), store.migrate()])).resolves.toEqual([undefined, undefined]);
  });

  it('миграция bounded отказывается при блокировке таблицы и повторяется после rollback', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE alert_bot_repairs IN ACCESS EXCLUSIVE MODE');
    const startedAt = Date.now();
    const observed = store.migrate().then(
      () => ({ status: 'resolved' as const }),
      (error) => ({ status: 'rejected' as const, error }),
    );
    try {
      const outcome = await observed;
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') expect(outcome.error).toMatchObject({ code: '55P03' });
      expect(Date.now() - startedAt).toBeLessThan(7_000);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release(true);
      await observed;
    }
    await expect(store.migrate()).resolves.toBeUndefined();
  });

  it('один update идемпотентен и один active repair на chat допускается', async () => {
    const input = repairInput('admission');
    const first = await store.admitRepair(input);
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') return;

    await expect(store.admitRepair(input)).resolves.toEqual({ status: 'existing', repairId: first.repairId });
    await expect(store.admitRepair(repairInput('admission'))).resolves.toEqual({ status: 'busy' });

    const repair = await store.findRepair(first.repairId);
    expect(repair).toMatchObject({
      id: first.repairId,
      updateId: input.updateId,
      turnId: null,
      chatId: input.chatId,
      adminTgId: input.adminTgId,
      instruction: input.instruction,
      status: 'requested',
      failureKind: null,
      mutationCount: 0,
      createdAt: expect.any(Date),
      finishedAt: null,
    });
    expect(typeof repair?.updateId).toBe('number');
    await expect(store.findRepairByUpdate(input.updateId)).resolves.toEqual(repair);
    await expect(store.findRepairByUpdate(-1)).resolves.toBeNull();
    await expect(store.findActiveRepair('admission')).resolves.toEqual(repair);
    await expect(store.findRepair(MISSING_ID)).resolves.toBeNull();
    await expect(store.findActiveRepair('other-chat')).resolves.toBeNull();
  });

  it('Promise.all двух разных updates одного chat даёт ровно один accepted', async () => {
    const results = await Promise.all([
      store.admitRepair(repairInput('concurrent-admission')),
      store.admitRepair(repairInput('concurrent-admission')),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['accepted', 'busy']);
    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM alert_bot_repairs WHERE chat_id = 'concurrent-admission'",
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('concurrent same update даёт один accepted и один existing', async () => {
    const input = repairInput('concurrent-same-update');
    const results = await Promise.all([
      store.admitRepair(input),
      store.admitRepair(input),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['accepted', 'existing']);
    expect(new Set(results.map((result) => result.status === 'busy' ? null : result.repairId)).size).toBe(1);
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM alert_bot_repairs WHERE update_id = $1',
      [input.updateId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('повторный same update после terminal возвращает existing', async () => {
    const input = repairInput('terminal-same-update');
    const first = await store.admitRepair(input);
    if (first.status !== 'accepted') throw new Error('repair not accepted');
    expect(await store.finishRepair(first.repairId, 'verified', 0)).toBe(true);

    await expect(store.admitRepair(input)).resolves.toEqual({
      status: 'existing', repairId: first.repairId,
    });
  });

  it('job lifecycle допускает одну active job и следующую sequence после finish', async () => {
    const repairId = await admit('jobs');
    const first = await store.createJob(jobInput(repairId));
    expect(first).toEqual({ id: expect.any(String), sequence: 1 });
    if (!first) return;

    await expect(store.createJob(jobInput(repairId))).resolves.toBeNull();
    await expect(store.createJob(jobInput(MISSING_ID))).resolves.toBeNull();
    await expect(store.findJob(first.id)).resolves.toMatchObject({
      id: first.id,
      repairId,
      sequence: 1,
      host: 'prod',
      command: 'systemctl restart demo',
      kind: 'exec',
      mutates: true,
      interruptible: false,
      timeoutMs: 5_000,
      status: 'queued',
      exitCode: null,
      stdout: '',
      stderr: '',
      failureKind: null,
    });
    expect(await store.markJobRunning(first.id)).toBe(true);
    expect(await store.markJobRunning(first.id)).toBe(false);
    expect(await store.finishJob(first.id, {
      status: 'succeeded', exitCode: 0, stdout: 'ok', stderr: '', failureKind: null,
    })).toBe(true);

    const second = await store.createJob(jobInput(repairId, {
      host: 'relay', command: 'curl verify', kind: 'verify', mutates: false,
      interruptible: true, timeoutMs: 1_500,
    }));
    expect(second).toEqual({ id: expect.any(String), sequence: 2 });
    const jobs = await store.listJobs(repairId);
    expect(jobs.map((job) => job.sequence)).toEqual([1, 2]);
    expect(jobs[0]).toMatchObject({ status: 'succeeded', exitCode: 0, stdout: 'ok', stderr: '' });
    expect(jobs[1]).toMatchObject({
      host: 'relay', command: 'curl verify', kind: 'verify', mutates: false,
      interruptible: true, timeoutMs: 1_500, status: 'queued',
    });
    expect(typeof jobs[0].sequence).toBe('number');
    expect(typeof jobs[0].exitCode).toBe('number');
    expect(typeof jobs[1].timeoutMs).toBe('number');
    await expect(store.findJob(MISSING_ID)).resolves.toBeNull();
    await expect(store.listJobs(MISSING_ID)).resolves.toEqual([]);
  });

  it.each(['process_close_unconfirmed', 'remote_outcome_unknown'] as const)('%s блокирует следующую job на уровне PostgreSQL', async (failureKind) => {
    const repairId = await admit(`fence-${failureKind}`);
    const first = await store.createJob(jobInput(repairId));
    expect(first).not.toBeNull();
    await expect(store.hasUnknownOutcome(repairId)).resolves.toBe(false);
    await store.finishJob(first!.id, {
      status: 'interrupted', exitCode: null, stdout: '', stderr: '', failureKind,
    });
    await expect(store.hasUnknownOutcome(repairId)).resolves.toBe(true);
    await expect(store.createJob(jobInput(repairId))).resolves.toBeNull();
  });

  it('finishUnknownAndCancelRepair атомарно закрывает окно cancel_requested без unknown', async () => {
    const repairId = await admit('atomic-unknown-cancel');
    await store.markRepairRunning(repairId, TURN_ID);
    const first = await store.createJob(jobInput(repairId));
    expect(first).not.toBeNull();
    expect(await store.markJobRunning(first!.id)).toBe(true);
    await expect(store.createJob(jobInput(repairId))).resolves.toBeNull();

    await expect(store.finishUnknownAndCancelRepair(first!.id, repairId, {
      status: 'interrupted', exitCode: null, stdout: '', stderr: '', failureKind: 'remote_outcome_unknown',
    })).resolves.toBe(true);
    await expect(store.findRepair(repairId)).resolves.toMatchObject({ status: 'cancel_requested' });
    await expect(store.findJob(first!.id)).resolves.toMatchObject({
      status: 'interrupted', failureKind: 'remote_outcome_unknown',
    });

    const executor = new AlertBotRepairExecutor(store);
    const jobs = new AlertBotRepairJobs(store, executor);
    const spawn = jest.spyOn(childProcess, 'spawn');
    try {
      await expect(jobs.start({
        ...guard(repairId, 'atomic-unknown-cancel'), scope: 'repair', adminUserId: 'admin-user',
      }, 'exec', { host: 'prod', command: 'printf must-not-run' })).rejects.toThrow('repair_outcome_unknown');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      await executor.stopAll();
    }
  });

  it.each(['process_close_unconfirmed', 'remote_outcome_unknown'] as const)('%s create-first lock schedule не даёт deadlock', async (failureKind) => {
    const chatId = `lock-create-first-${failureKind}`;
    const repairId = await admit(chatId);
    await store.markRepairRunning(repairId, TURN_ID);
    const first = await store.createJob(jobInput(repairId));
    expect(await store.markJobRunning(first!.id)).toBe(true);

    let releaseGate!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gatedStore = storeWithRepairBarrier(async () => {
      markEntered();
      await gate;
    });
    const creating = gatedStore.createJob(jobInput(repairId));
    await boundedEnteredForTest(entered);
    const finishing = store.finishUnknownAndCancelRepair(first!.id, repairId, {
      status: 'interrupted', exitCode: null, stdout: '', stderr: '', failureKind,
    });
    const operations = Promise.allSettled([creating, finishing]);
    try {
      await waitForFinishLock();
    } finally {
      releaseGate();
      await boundedStoppedForCleanup(operations.then(() => undefined));
    }
    expect(await operations).toEqual([
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: true },
    ]);
    await expect(store.findRepair(repairId)).resolves.toMatchObject({ status: 'cancel_requested' });
    await expect(store.findJob(first!.id)).resolves.toMatchObject({ status: 'interrupted', failureKind });
    await expectUnknownStart(repairId, chatId);
  });

  it.each(['process_close_unconfirmed', 'remote_outcome_unknown'] as const)('%s finish-first lock schedule сериализует createJob', async (failureKind) => {
    const chatId = `lock-finish-first-${failureKind}`;
    const repairId = await admit(chatId);
    await store.markRepairRunning(repairId, TURN_ID);
    const first = await store.createJob(jobInput(repairId));
    expect(await store.markJobRunning(first!.id)).toBe(true);
    await pool.query(
      `CREATE FUNCTION ${SCHEMA}.repair_unknown_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN PERFORM pg_advisory_xact_lock(918273); RETURN NEW; END; $$`,
    );
    await pool.query(
      `CREATE TRIGGER repair_unknown_barrier BEFORE UPDATE ON alert_bot_repair_jobs
       FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.repair_unknown_barrier()`,
    );
    const barrier = await pool.connect();
    await barrier.query('BEGIN');
    await barrier.query('SELECT pg_advisory_xact_lock(918273)');
    const finishing = store.finishUnknownAndCancelRepair(first!.id, repairId, {
      status: 'interrupted', exitCode: null, stdout: '', stderr: '', failureKind,
    });
    let operations: Promise<PromiseSettledResult<any>[]> | undefined;
    try {
      await waitForFinishLock();
      let createSettled = false;
      const creating = store.createJob(jobInput(repairId)).then(
        (value) => { createSettled = true; return value; },
        (error) => { createSettled = true; throw error; },
      );
      operations = Promise.allSettled([finishing, creating]);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(createSettled).toBe(false);
    } finally {
      await barrier.query('ROLLBACK').catch(() => undefined);
      barrier.release(true);
      if (operations) await boundedStoppedForCleanup(operations.then(() => undefined));
      else await boundedStoppedForCleanup(finishing.then(() => undefined, () => undefined));
      await pool.query('DROP TRIGGER IF EXISTS repair_unknown_barrier ON alert_bot_repair_jobs').catch(() => undefined);
      await pool.query(`DROP FUNCTION IF EXISTS ${SCHEMA}.repair_unknown_barrier()`).catch(() => undefined);
    }
    expect(await operations!).toEqual([
      { status: 'fulfilled', value: true },
      { status: 'fulfilled', value: null },
    ]);
    await expect(store.findRepair(repairId)).resolves.toMatchObject({ status: 'cancel_requested' });
    await expect(store.findJob(first!.id)).resolves.toMatchObject({ status: 'interrupted', failureKind });
    await expectUnknownStart(repairId, chatId);
  });

  it.each(['failed', 'succeeded'] as const)('%s не блокирует следующую job после lock serialization', async (status) => {
    const repairId = await admit(`normal-${status}-serialization`);
    const first = await store.createJob(jobInput(repairId));
    await store.finishJob(first!.id, {
      status, exitCode: status === 'succeeded' ? 0 : 1, stdout: '', stderr: '', failureKind: null,
    });
    await expect(store.createJob(jobInput(repairId))).resolves.not.toBeNull();
  });

  it('Promise.all двух первых jobs создаёт ровно одну row', async () => {
    const repairId = await admit('concurrent-jobs');
    const results = await Promise.all([
      store.createJob(jobInput(repairId)),
      store.createJob(jobInput(repairId)),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results).toContain(null);
    const rows = await pool.query(
      'SELECT sequence FROM alert_bot_repair_jobs WHERE repair_id = $1',
      [repairId],
    );
    expect(rows.rows).toEqual([{ sequence: '1' }]);
  });

  it('чужой 23505 не превращается в null и тестовый constraint удаляется', async () => {
    const constraint = 'alert_bot_repair_jobs_spec_host_unique';
    await pool.query(`ALTER TABLE alert_bot_repair_jobs ADD CONSTRAINT ${constraint} UNIQUE (host)`);
    try {
      const firstRepair = await admit('unique-host-first');
      expect(await store.createJob(jobInput(firstRepair))).not.toBeNull();
      const secondRepair = await admit('unique-host-second');

      await expect(store.createJob(jobInput(secondRepair))).rejects.toMatchObject({
        code: '23505', constraint,
      });
    } finally {
      await pool.query(`ALTER TABLE alert_bot_repair_jobs DROP CONSTRAINT IF EXISTS ${constraint}`);
    }
  });

  it('markRepairRunning прикрепляет turn, а guard проверяет identity и статус', async () => {
    const repairId = await admit('guard');
    expect(await store.isActiveRepair(guard(repairId, 'guard'))).toBe(false);
    expect(await store.markRepairRunning(repairId, TURN_ID)).toBe(true);
    expect(await store.markRepairRunning(repairId, OTHER_TURN_ID)).toBe(false);
    expect((await store.findRepair(repairId))).toMatchObject({ status: 'running', turnId: TURN_ID });

    expect(await store.isActiveRepair(guard(repairId, 'guard'))).toBe(true);
    expect(await store.isActiveRepair(guard(repairId, 'guard', { turnId: OTHER_TURN_ID }))).toBe(false);
    expect(await store.isActiveRepair(guard(repairId, 'guard', { chatId: 'wrong' }))).toBe(false);
    expect(await store.isActiveRepair(guard(repairId, 'guard', { adminTgId: 'wrong' }))).toBe(false);
    expect(await store.isActiveRepair(guard(MISSING_ID, 'guard'))).toBe(false);

    expect(await store.requestCancel(repairId)).toBe(true);
    expect(await store.isActiveRepair(guard(repairId, 'guard'))).toBe(false);
    expect((await store.findActiveRepair('guard'))?.status).toBe('cancel_requested');
  });

  it('requestCancel закрывает последующий createJob', async () => {
    const repairId = await admit('cancel-before-job');
    expect(await store.markRepairRunning(repairId, TURN_ID)).toBe(true);
    expect(await store.requestCancel(repairId)).toBe(true);
    expect(await store.requestCancel(repairId)).toBe(false);

    await expect(store.createJob(jobInput(repairId))).resolves.toBeNull();
    expect(await store.finishRepair(repairId, 'cancelled', 0)).toBe(true);
    expect((await store.findRepair(repairId))?.status).toBe('cancelled');
  });

  it('cancel_requested нельзя перезаписать verified, но можно завершить cancelled', async () => {
    const repairId = await admit('cancel-fences-verified');
    expect(await store.markRepairRunning(repairId, TURN_ID)).toBe(true);
    expect(await store.requestCancel(repairId)).toBe(true);

    expect(await store.finishRepair(repairId, 'verified', 1)).toBe(false);
    expect((await store.findRepair(repairId))?.status).toBe('cancel_requested');
    expect(await store.finishRepair(repairId, 'cancelled', 1)).toBe(true);
    expect((await store.findRepair(repairId))?.status).toBe('cancelled');
  });

  it('entered wait bounded и проходит через cleanup при regression', async () => {
    const startedAt = Date.now();
    await expect(boundedEnteredForTest(new Promise<void>(() => undefined), 20))
      .rejects.toThrow('request_cancel_not_entered');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('cleanup stop wait bounded при regression и не требует исходного settle', async () => {
    const startedAt = Date.now();
    await expect(boundedStoppedForCleanup(new Promise<void>(() => undefined), 20)).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('cleanup forced release освобождает checked-out client перед pool.end', async () => {
    const cleanupPool = new Pool({ connectionString: PG, max: 1 });
    const client = await cleanupPool.connect();
    let timer: NodeJS.Timeout | undefined;
    let endCalled = false;
    try {
      forceReleaseForCleanup(client);
      endCalled = true;
      const outcome = await Promise.race([
        cleanupPool.end().then(() => 'ended'),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve('pool_end_hung'), 1_000); }),
      ]);
      expect(outcome).toBe('ended');
    } finally {
      if (timer) clearTimeout(timer);
      try { client.release(true); } catch { /* уже release */ }
      if (!endCalled) await cleanupPool.end();
    }
  });

  it('hanging requestCancel abort-ится при bounded stop и не удерживает единственный pool client', async () => {
    const repairId = await admit('cancel-abort-pool');
    const blocker = await pool.connect();
    const singlePool = new Pool({
      connectionString: PG, max: 1, options: `-c search_path=${SCHEMA}`,
    });
    let singleClient: PoolClient | undefined;
    singlePool.on('acquire', (client) => { singleClient = client; });
    const signals: Array<AbortSignal | undefined> = [];
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const pg = {
      query: (text: string, params?: any[], signal?: AbortSignal) => {
        if (text.includes("UPDATE alert_bot_repairs SET status = 'cancel_requested'")) {
          signals.push(signal);
          markEntered();
        }
        return queryWithCancellation(singlePool, text, params, signal);
      },
      getClient: () => singlePool.connect(),
    };
    const singleStore = new RepairStore(pg as any);
    const executor = new AlertBotRepairExecutor(singleStore);
    let stopped: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE alert_bot_repairs SET mutation_count = mutation_count WHERE id = $1', [repairId]);
      stopped = executor.stopRepair(repairId);
      await boundedEnteredForTest(entered);
      const outcome = await Promise.race([
        stopped.then(() => 'stopped'),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve('stop_hung'), 5_000); }),
      ]);
      expect(outcome).toBe('stopped');
      expect(singlePool.totalCount).toBe(1);
      expect(singlePool.idleCount).toBe(1);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      await expect(singleStore.findRepair(repairId)).resolves.toMatchObject({ id: repairId });
    } finally {
      if (timer) clearTimeout(timer);
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release(true);
      await boundedStoppedForCleanup(stopped);
      forceReleaseForCleanup(singleClient);
      await executor.stopAll();
      await singlePool.end();
    }
  });

  it('queued job нельзя запустить после requestCancel', async () => {
    const repairId = await admit('cancel-before-job-start');
    const job = await store.createJob(jobInput(repairId));
    expect(await store.requestCancel(repairId)).toBe(true);

    expect(await store.markJobRunning(job!.id)).toBe(false);
    expect((await store.findJob(job!.id))?.status).toBe('queued');
  });

  it('queued job нельзя запустить после terminal repair', async () => {
    const repairId = await admit('terminal-before-job-start');
    const job = await store.createJob(jobInput(repairId));
    expect(await store.finishRepair(repairId, 'failed', 0)).toBe(true);

    expect(await store.markJobRunning(job!.id)).toBe(false);
    expect((await store.findJob(job!.id))?.status).toBe('queued');
  });

  it('abandon атомарно отменяет requested и cancel_requested только без turn и освобождает chat', async () => {
    const requested = await admit('abandon-requested');
    expect(await store.abandon(requested)).toBe(true);
    expect(await store.abandon(requested)).toBe(false);
    expect((await store.findRepair(requested))).toMatchObject({
      status: 'cancelled', finishedAt: expect.any(Date),
    });

    const cancelling = await admit('abandon-cancelling');
    expect(await store.requestCancel(cancelling)).toBe(true);
    expect(await store.abandon(cancelling)).toBe(true);
    expect(await store.abandon(cancelling)).toBe(false);
    expect((await store.findRepair(cancelling))).toMatchObject({
      status: 'cancelled', turnId: null, finishedAt: expect.any(Date),
    });
    await expect(store.admitRepair(repairInput('abandon-cancelling')))
      .resolves.toMatchObject({ status: 'accepted' });

    const running = await admit('abandon-running');
    expect(await store.markRepairRunning(running, TURN_ID)).toBe(true);
    expect(await store.abandon(running)).toBe(false);

    const attached = await admit('abandon-attached');
    await pool.query('UPDATE alert_bot_repairs SET turn_id = $2 WHERE id = $1', [attached, OTHER_TURN_ID]);
    expect(await store.abandon(attached)).toBe(false);
  });

  it('interruptActive завершает active jobs и repairs без перезапуска', async () => {
    const requested = await admit('interrupt-requested');
    const queued = await store.createJob(jobInput(requested));
    const running = await admit('interrupt-running');
    expect(await store.markRepairRunning(running, TURN_ID)).toBe(true);
    const runningJob = await store.createJob(jobInput(running));
    expect(await store.markJobRunning(runningJob!.id)).toBe(true);
    const cancelling = await admit('interrupt-cancelling');
    expect(await store.requestCancel(cancelling)).toBe(true);
    const terminal = await admit('interrupt-terminal');
    const terminalJob = await store.createJob(jobInput(terminal));
    expect(await store.finishJob(terminalJob!.id, {
      status: 'succeeded', exitCode: 0, stdout: 'done', stderr: '',
    })).toBe(true);
    expect(await store.finishRepair(terminal, 'verified', 1)).toBe(true);

    const interrupted = await store.interruptActive();
    expect(interrupted.map((repair) => repair.id).sort()).toEqual([requested, running, cancelling].sort());
    expect(interrupted.every((repair) => repair.status === 'interrupted' && repair.finishedAt instanceof Date)).toBe(true);
    expect((await store.listJobs(requested)).find((job) => job.id === queued!.id)?.status).toBe('interrupted');
    expect((await store.listJobs(running)).find((job) => job.id === runningJob!.id)?.status).toBe('interrupted');
    expect((await store.findRepair(terminal))?.status).toBe('verified');
    expect((await store.findJob(terminalJob!.id))?.status).toBe('succeeded');
    await expect(store.interruptActive()).resolves.toEqual([]);
    expect((await store.findJob(queued!.id))?.status).toBe('interrupted');
  });

  it('cleanup удаляет terminal repairs старше 90 дней и каскадно jobs', async () => {
    const oldTerminal = await admit('cleanup-old-terminal');
    const oldJob = await store.createJob(jobInput(oldTerminal));
    expect(await store.finishJob(oldJob!.id, {
      status: 'succeeded', exitCode: 0, stdout: '', stderr: '',
    })).toBe(true);
    expect(await store.finishRepair(oldTerminal, 'verified', 1)).toBe(true);
    const oldActive = await admit('cleanup-old-active');
    const activeJob = await store.createJob(jobInput(oldActive));
    const freshTerminal = await admit('cleanup-fresh-terminal');
    expect(await store.finishRepair(freshTerminal, 'cancelled', 0)).toBe(true);
    await pool.query(
      "UPDATE alert_bot_repairs SET created_at = now() - interval '91 days' WHERE id = ANY($1::uuid[])",
      [[oldTerminal, oldActive]],
    );

    await store.cleanup();

    await expect(store.findRepair(oldTerminal)).resolves.toBeNull();
    await expect(store.findJob(oldJob!.id)).resolves.toBeNull();
    await expect(store.findRepair(oldActive)).resolves.not.toBeNull();
    await expect(store.findJob(activeJob!.id)).resolves.not.toBeNull();
    await expect(store.findRepair(freshTerminal)).resolves.not.toBeNull();
  });

  it('terminal repair и terminal job нельзя перезаписать', async () => {
    const repairId = await admit('terminal-overwrite');
    const job = await store.createJob(jobInput(repairId));
    expect(await store.finishJob(job!.id, {
      status: 'succeeded', exitCode: 0, stdout: 'first', stderr: '', failureKind: null,
    })).toBe(true);
    expect(await store.finishJob(job!.id, {
      status: 'failed', exitCode: 1, stdout: 'second', stderr: 'bad', failureKind: 'exec_failed',
    })).toBe(false);
    expect(await store.findJob(job!.id)).toMatchObject({
      status: 'succeeded', exitCode: 0, stdout: 'first', stderr: '', failureKind: null,
    });

    expect(await store.finishRepair(repairId, 'verified', 1)).toBe(true);
    expect(await store.finishRepair(repairId, 'failed', 99)).toBe(false);
    expect((await store.findRepair(repairId))).toMatchObject({
      status: 'verified', mutationCount: 1, finishedAt: expect.any(Date),
    });
    expect(await store.finishRepair(MISSING_ID, 'failed', 0)).toBe(false);
    expect(await store.finishJob(MISSING_ID, {
      status: 'failed', exitCode: 1, stdout: '', stderr: '',
    })).toBe(false);
  });
});
