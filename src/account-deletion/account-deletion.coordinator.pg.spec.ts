import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { AccountDeletionCoordinator } from './account-deletion.coordinator';
import { AccountDeletionJobs, mapDeletionJob } from './account-deletion.jobs';
import { AccountDeletionPlanner } from './account-deletion.planner';
import { AccountDeletionRegistry } from './account-deletion.registry';
import { AccountDeletionRunner } from './account-deletion.runner';
import {
  DELETION_RESOURCE_TYPES,
  DeletionCancelledError,
} from './account-deletion.safe';
import type { PgService } from '../common/services/pg.service';
import type {
  AccountDeletionAdapter,
  DeletionAccount,
  DeletionExecution,
  DeletionJobRow,
  DeletionResourceType,
} from './account-deletion.types';

const PG = process.env.PROVISIONING_PG_URL;
const PROVIDER_RAW = 'PROVIDER_RAW_SECRET';

type AdapterImplementation = (
  job: DeletionJobRow,
  ctx: DeletionExecution,
) => Promise<void>;

(PG ? describe : describe.skip)('account deletion coordinator', () => {
  let pool: Pool;
  let logLines: string[];

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG });
    await pool.query(`
      CREATE TABLE user_id (
        internal_id text PRIMARY KEY,
        state text,
        update_date timestamptz DEFAULT now()
      )
    `);
    await pool.query(readFileSync(
      'src/account-deletion/migrations/001_account_deletion.sql',
      'utf8',
    ));
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM account_deletion_jobs');
    await pool.query('DELETE FROM user_id');
    delete process.env.ACCOUNT_DELETION_WORKER_ENABLED;
    logLines = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, method).mockImplementation((message: any) => {
        logLines.push(String(message));
      });
    }
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.ACCOUNT_DELETION_WORKER_ENABLED;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DROP TABLE IF EXISTS account_deletion_jobs, user_id')
      .catch(() => undefined);
    await pool.end();
  });

  function account(userId: string, deletedAt = new Date(Date.now() - 60_000)): DeletionAccount {
    return { userId, deletionId: randomUUID(), deletedAt };
  }

  async function insertDeleted(value: DeletionAccount): Promise<void> {
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id)
       VALUES ($1,'deleted',$2,$3)`,
      [value.userId, value.deletedAt, value.deletionId],
    );
  }

  async function insertJob(
    value: DeletionAccount,
    resourceType: DeletionResourceType,
    resourceKey: string,
    overrides: {
      status?: DeletionJobRow['status'];
      attempts?: number;
      nextAttemptAt?: Date;
      leaseUntil?: Date | null;
      payload?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const phase = resourceType === 'account.core.immediate' || resourceType.endsWith('.stop')
      ? 'immediate'
      : 'purge';
    const result = await pool.query(
      `INSERT INTO account_deletion_jobs
        (deletion_id,user_id,resource_type,resource_key,phase,payload_jsonb,
         status,attempts,next_attempt_at,lease_until)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       RETURNING id`,
      [
        value.deletionId,
        value.userId,
        resourceType,
        resourceKey,
        phase,
        JSON.stringify(overrides.payload ?? { externalId: 'external-1' }),
        overrides.status ?? 'pending',
        overrides.attempts ?? 0,
        overrides.nextAttemptAt ?? new Date(Date.now() - 60_000),
        overrides.leaseUntil ?? null,
      ],
    );
    return result.rows[0].id;
  }

  async function rawJob(id: string): Promise<any> {
    const result = await pool.query('SELECT * FROM account_deletion_jobs WHERE id=$1', [id]);
    return result.rows[0];
  }

  async function job(id: string): Promise<DeletionJobRow> {
    return mapDeletionJob(await rawJob(id));
  }

  function compose(
    implementations: Partial<Record<DeletionResourceType, AdapterImplementation>> = {},
    lockResult: { release(): Promise<void> } | null = { release: async () => undefined },
  ) {
    const jobs = new AccountDeletionJobs(pool);
    const registry = new AccountDeletionRegistry();
    const executions: string[] = [];
    const adapters: Partial<Record<DeletionResourceType, jest.MockedFunction<AdapterImplementation>>> = {};

    for (const [resourceType, implementation] of Object.entries(implementations) as Array<[
      DeletionResourceType,
      AdapterImplementation,
    ]>) {
      const execute = jest.fn<ReturnType<AdapterImplementation>, Parameters<AdapterImplementation>>(
        async (value, ctx) => {
          await ctx.assertCurrent(value);
          executions.push(`${resourceType}:${value.resourceKey}`);
          await implementation(value, ctx);
        },
      );
      adapters[resourceType] = execute;
      registry.register({ resourceTypes: [resourceType], execute });
    }

    const pg = {
      query: pool.query.bind(pool),
      tryAdvisoryLock: jest.fn(async () => lockResult),
    } as unknown as PgService;
    const planner = {
      collect: jest.fn(async () => ({ jobs: [], skips: [] })),
      persist: jest.fn(async () => undefined),
    } as unknown as AccountDeletionPlanner;
    const runner = new AccountDeletionRunner(pg, jobs, registry);
    const coordinator = new AccountDeletionCoordinator(pg, planner, jobs, runner);
    return { jobs, registry, executions, adapters, pg, planner, runner, coordinator };
  }

  it('reclaim expired lease, не выбирает historical и не пишет userId в лог', async () => {
    process.env.ACCOUNT_DELETION_WORKER_ENABLED = 'true';
    const historical = account('u-historical');
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id)
       VALUES ($1,'deleted',NULL,NULL)`,
      [historical.userId],
    );
    const historicalJob = await insertJob(historical, 'routine.stop', 'historical');

    const current = account('u-current');
    await insertDeleted(current);
    const first = await insertJob(current, 'calendar.stop', 'cal-1', {
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 120_000),
      leaseUntil: new Date(Date.now() - 1_000),
    });
    const second = await insertJob(current, 'routine.stop', 'routine-1', {
      nextAttemptAt: new Date(Date.now() - 30_000),
    });
    const { coordinator, executions, planner } = compose({
      'calendar.stop': async () => undefined,
      'routine.stop': async () => undefined,
    });

    await coordinator.tick({ retentionMs: 0, batchSize: 1 });

    expect(await job(first)).toMatchObject({ status: 'done', attempts: 2, leaseUntil: null });
    expect(await job(second)).toMatchObject({ status: 'done', attempts: 1 });
    expect(await job(historicalJob)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(executions).toEqual(['calendar.stop:cal-1', 'routine.stop:routine-1']);
    expect(planner.collect).toHaveBeenCalledTimes(1);
    expect(logLines.join('\n')).not.toContain(current.userId);
  });

  it('изолирует external_5xx, сохраняет payload и выполняет независимый ресурс', async () => {
    process.env.ACCOUNT_DELETION_WORKER_ENABLED = 'true';
    const current = account('u-failure');
    await insertDeleted(current);
    const failed = await insertJob(current, 'calendar.stop', 'cal-1', {
      nextAttemptAt: new Date(Date.now() - 120_000),
      payload: { externalId: 'last-confirmed-id' },
    });
    const independent = await insertJob(current, 'routine.stop', 'routine-1');
    const { coordinator } = compose({
      'calendar.stop': async () => {
        const error: any = new Error(`${PROVIDER_RAW} ${current.userId}`);
        error.response = { status: 503, data: PROVIDER_RAW };
        throw error;
      },
      'routine.stop': async () => undefined,
    });

    const before = Date.now();
    await coordinator.tick({ retentionMs: 0 });
    const after = Date.now();

    expect(await job(failed)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastErrorKind: 'external_5xx',
      leaseUntil: null,
      payload: { externalId: 'last-confirmed-id' },
    });
    const failedRaw = await rawJob(failed);
    expect(failedRaw.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 55_000);
    expect(failedRaw.next_attempt_at.getTime()).toBeLessThanOrEqual(after + 65_000);
    expect(await job(independent)).toMatchObject({ status: 'done' });
    const logs = logLines.join('\n');
    expect(logs).toContain('external_5xx');
    expect(logs).not.toContain(PROVIDER_RAW);
    expect(logs).not.toContain(current.userId);
  });

  it('не вызывает planner/adapters и SQL, если advisory lock уже занят', async () => {
    process.env.ACCOUNT_DELETION_WORKER_ENABLED = 'true';
    const current = account('u-locked');
    await insertDeleted(current);
    const { coordinator, pg, planner, runner } = compose({}, null);
    const runAccount = jest.spyOn(runner, 'runAccount');
    const query = jest.spyOn(pg, 'query');

    await coordinator.tick({ retentionMs: 0 });

    expect(pg.tryAdvisoryLock).toHaveBeenCalledWith(1947433922);
    expect(query).not.toHaveBeenCalled();
    expect(planner.collect).not.toHaveBeenCalled();
    expect(planner.persist).not.toHaveBeenCalled();
    expect(runAccount).not.toHaveBeenCalled();
  });

  it('при отсутствующем env по умолчанию выключен и не выполняет ни одного SQL', async () => {
    const { coordinator, pg, planner } = compose();
    const query = jest.spyOn(pg, 'query');

    await coordinator.tick({ retentionMs: 0 });

    expect(pg.tryAdvisoryLock).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(planner.collect).not.toHaveBeenCalled();
  });

  it('core ждёт stop даже при более раннем next_attempt_at; нулевое число stop не блокирует', async () => {
    const withStop = account('u-dependencies');
    await insertDeleted(withStop);
    const core = await insertJob(withStop, 'account.core.purge', 'account', {
      nextAttemptAt: new Date(Date.now() - 120_000),
    });
    const stop = await insertJob(withStop, 'routine.stop', 'routine-1', {
      nextAttemptAt: new Date(Date.now() - 60_000),
    });
    const first = compose({
      'account.core.purge': async () => undefined,
      'routine.stop': async () => undefined,
    });

    await first.runner.runAccount(withStop.deletionId);

    expect(first.executions).toEqual(['routine.stop:routine-1', 'account.core.purge:account']);
    expect(await job(stop)).toMatchObject({ status: 'done' });
    expect(await job(core)).toMatchObject({ status: 'done' });

    const withoutStop = account('u-no-stops');
    await insertDeleted(withoutStop);
    const independentCore = await insertJob(withoutStop, 'account.core.purge', 'account');
    const second = compose({ 'account.core.purge': async () => undefined });

    await second.runner.runAccount(withoutStop.deletionId);

    expect(second.executions).toEqual(['account.core.purge:account']);
    expect(await job(independentCore)).toMatchObject({ status: 'done' });
  });

  it('failed stop блокирует core, а успешный retry освобождает core', async () => {
    const current = account('u-stop-retry');
    await insertDeleted(current);
    const core = await insertJob(current, 'account.core.purge', 'account', {
      nextAttemptAt: new Date(Date.now() - 120_000),
    });
    const stop = await insertJob(current, 'calendar.stop', 'cal-1');
    const calendar = jest.fn<ReturnType<AdapterImplementation>, Parameters<AdapterImplementation>>()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValue(undefined);
    const { runner, executions } = compose({
      'calendar.stop': calendar,
      'account.core.purge': async () => undefined,
    });

    await runner.runAccount(current.deletionId);

    expect(await job(stop)).toMatchObject({ status: 'failed', lastErrorKind: 'external_5xx' });
    expect(await job(core)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(executions).toEqual(['calendar.stop:cal-1']);

    await pool.query(
      'UPDATE account_deletion_jobs SET next_attempt_at=now()-interval \'1 second\' WHERE id=$1',
      [stop],
    );
    await runner.runAccount(current.deletionId);

    expect(await job(stop)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await job(core)).toMatchObject({ status: 'done', attempts: 1 });
    expect(executions).toEqual([
      'calendar.stop:cal-1',
      'calendar.stop:cal-1',
      'account.core.purge:account',
    ]);
  });

  it('product.purge ждёт только product.stop с тем же resourceKey', async () => {
    const current = account('u-product-dependencies');
    await insertDeleted(current);
    const purge = await insertJob(current, 'product.purge', 'product-own', {
      nextAttemptAt: new Date(Date.now() - 120_000),
    });
    const ownStop = await insertJob(current, 'product.stop', 'product-own');
    const otherStop = await insertJob(current, 'product.stop', 'product-other');
    const { runner, executions } = compose({
      'product.stop': async (value) => {
        if (value.resourceKey === 'product-other') throw { response: { status: 503 } };
      },
      'product.purge': async () => undefined,
    });

    await runner.runAccount(current.deletionId);

    expect(executions.indexOf('product.stop:product-own'))
      .toBeLessThan(executions.indexOf('product.purge:product-own'));
    expect(await job(ownStop)).toMatchObject({ status: 'done' });
    expect(await job(otherStop)).toMatchObject({ status: 'failed' });
    expect(await job(purge)).toMatchObject({ status: 'done' });
  });

  it('custom-agent.purge ждёт все telegram.purge', async () => {
    const current = account('u-telegram-dependencies');
    await insertDeleted(current);
    const custom = await insertJob(current, 'custom-agent.purge', 'agent-1', {
      nextAttemptAt: new Date(Date.now() - 120_000),
    });
    const firstTelegram = await insertJob(current, 'telegram.purge', 'bot-1');
    const secondTelegram = await insertJob(current, 'telegram.purge', 'bot-2');
    const telegram = jest.fn<ReturnType<AdapterImplementation>, Parameters<AdapterImplementation>>(
      async (value) => {
        if (value.resourceKey === 'bot-1' && value.attempts === 1) {
          throw { response: { status: 503 } };
        }
      },
    );
    const { runner } = compose({
      'telegram.purge': telegram,
      'custom-agent.purge': async () => undefined,
    });

    await runner.runAccount(current.deletionId);

    expect(await job(firstTelegram)).toMatchObject({ status: 'failed' });
    expect(await job(secondTelegram)).toMatchObject({ status: 'done' });
    expect(await job(custom)).toMatchObject({ status: 'pending', attempts: 0 });

    await pool.query(
      'UPDATE account_deletion_jobs SET next_attempt_at=now()-interval \'1 second\' WHERE id=$1',
      [firstTelegram],
    );
    await runner.runAccount(current.deletionId);

    expect(await job(firstTelegram)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await job(custom)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('voice.purge ждёт свой voice.stop и все voice-document.purge', async () => {
    const current = account('u-voice-dependencies');
    await insertDeleted(current);
    const purge = await insertJob(current, 'voice.purge', 'voice-own', {
      nextAttemptAt: new Date(Date.now() - 120_000),
    });
    const ownStop = await insertJob(current, 'voice.stop', 'voice-own');
    const otherStop = await insertJob(current, 'voice.stop', 'voice-other', {
      status: 'failed',
      attempts: 1,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    const document = await insertJob(current, 'voice-document.purge', 'document-1');
    const voiceDocument = jest.fn<ReturnType<AdapterImplementation>, Parameters<AdapterImplementation>>()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValue(undefined);
    const { runner } = compose({
      'voice.stop': async () => undefined,
      'voice-document.purge': voiceDocument,
      'voice.purge': async () => undefined,
    });

    await runner.runAccount(current.deletionId);

    expect(await job(ownStop)).toMatchObject({ status: 'done' });
    expect(await job(otherStop)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await job(document)).toMatchObject({ status: 'failed' });
    expect(await job(purge)).toMatchObject({ status: 'pending', attempts: 0 });

    await pool.query(
      'UPDATE account_deletion_jobs SET next_attempt_at=now()-interval \'1 second\' WHERE id=$1',
      [document],
    );
    await runner.runAccount(current.deletionId);

    expect(await job(document)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await job(purge)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('dueAccounts keyset batch=1 обходит все due accounts и исключает historical/future', async () => {
    process.env.ACCOUNT_DELETION_WORKER_ENABLED = 'true';
    const deletedAt = new Date(Date.now() - 120_000);
    const accounts = [
      account('u-b', deletedAt),
      account('u-a', deletedAt),
      account('u-c', new Date(deletedAt.getTime() + 1_000)),
    ];
    for (const value of accounts) await insertDeleted(value);
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id)
       VALUES ('u-historical','deleted',NULL,NULL),
              ('u-future','deleted',$1,$2)`,
      [new Date(Date.now() + 60_000), randomUUID()],
    );
    const { coordinator, planner, runner } = compose();
    const runAccount = jest.spyOn(runner, 'runAccount');

    await coordinator.tick({ retentionMs: 0, batchSize: 1 });

    const processed = (planner.collect as unknown as jest.Mock).mock.calls
      .map((call) => call[1].userId);
    expect(processed).toEqual(['u-a', 'u-b', 'u-c']);
    expect(runAccount.mock.calls.map((call) => call[0])).toEqual(
      ['u-a', 'u-b', 'u-c'].map((userId) => accounts.find((value) => value.userId === userId)!.deletionId),
    );
    expect((planner.collect as unknown as jest.Mock).mock.calls.every((call) => call[2] === 'merge'))
      .toBe(true);
  });

  it('keyset сохраняет PG microseconds и не возвращает последний account повторно', async () => {
    process.env.ACCOUNT_DELETION_WORKER_ENABLED = 'true';
    const first = account('u-cursor-a');
    const second = account('u-cursor-b');
    await pool.query(
      `INSERT INTO user_id (internal_id,state,deleted_at,deletion_id)
       VALUES
         ($1,'deleted',now()-interval '1 day'+interval '123 microseconds',$2),
         ($3,'deleted',now()-interval '1 day'+interval '123 microseconds',$4)`,
      [first.userId, first.deletionId, second.userId, second.deletionId],
    );
    const lock = { release: jest.fn(async () => undefined) };
    const { jobs, coordinator, planner } = compose({}, lock);
    const originalDueAccounts = jobs.dueAccounts.bind(jobs);
    let dueCalls = 0;
    const dueSpy = jest.spyOn(jobs, 'dueAccounts').mockImplementation(
      async (after, batchSize, retentionMs) => {
        dueCalls += 1;
        if (dueCalls > 4) throw new Error('KEYSET_DID_NOT_ADVANCE');
        return originalDueAccounts(after, batchSize, retentionMs);
      },
    );

    await expect(coordinator.tick({ retentionMs: 0, batchSize: 1 }))
      .resolves.toBeUndefined();

    const processed = (planner.collect as unknown as jest.Mock).mock.calls
      .map((call) => call[1].userId);
    expect(processed).toEqual([first.userId, second.userId]);
    expect(dueSpy.mock.calls).toHaveLength(3);
    expect(dueSpy.mock.calls[0][0]).toBeNull();
    expect(dueSpy.mock.calls[1][0]).toEqual([expect.any(String), first.userId]);
    expect(dueSpy.mock.calls[2][0]).toEqual([expect.any(String), second.userId]);
    expect((dueSpy.mock.calls[1][0] as unknown as [string, string])[0]).toMatch(/\.\d{1,6}/);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('продолжает tick после planner ошибки earliest account и логирует только safe kind', async () => {
    process.env.ACCOUNT_DELETION_WORKER_ENABLED = 'true';
    const earliest = account('u-earliest-error', new Date(Date.now() - 120_000));
    const next = account('u-next-after-error', new Date(Date.now() - 60_000));
    await insertDeleted(earliest);
    await insertDeleted(next);
    const lock = { release: jest.fn(async () => undefined) };
    const { coordinator, planner, runner } = compose({}, lock);
    (planner.collect as unknown as jest.Mock).mockImplementation(async (_db, value) => {
      if (value.userId === earliest.userId) {
        const error: any = new Error(`${PROVIDER_RAW} ${earliest.userId}`);
        error.response = { status: 503 };
        throw error;
      }
      return { jobs: [], skips: [] };
    });
    const runAccount = jest.spyOn(runner, 'runAccount');

    await expect(coordinator.tick({ retentionMs: 0 })).resolves.toBeUndefined();

    expect(runAccount.mock.calls.map((call) => call[0])).toEqual([next.deletionId]);
    expect(planner.persist).toHaveBeenCalledTimes(1);
    expect((planner.persist as unknown as jest.Mock).mock.calls[0][1].userId)
      .toBe(next.userId);
    const logs = logLines.join('\n');
    expect(logs).toContain('type=account.core.purge');
    expect(logs).toContain('attempt=0');
    expect(logs).toContain('kind=external_5xx');
    expect(logs).not.toContain(PROVIDER_RAW);
    expect(logs).not.toContain(earliest.userId);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('originOf различает explicit и использует merge при отсутствии core', async () => {
    const explicit = account('u-origin-explicit');
    const merge = account('u-origin-merge');
    await insertDeleted(explicit);
    await insertDeleted(merge);
    await insertJob(explicit, 'account.core.immediate', 'account');
    const { jobs } = compose();

    await expect(jobs.originOf(explicit)).resolves.toBe('explicit');
    await expect(jobs.originOf(merge)).resolves.toBe('merge');
  });

  it('claimNext не выдаёт активный lease', async () => {
    const current = account('u-active-lease');
    await insertDeleted(current);
    await insertJob(current, 'routine.stop', 'routine-1', {
      status: 'running',
      attempts: 1,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    const { jobs } = compose();

    await expect(jobs.claimNext(current.deletionId)).resolves.toBeNull();
  });

  it('heartbeat обновляет in-memory lease по БД с микросекундами и сохраняет stale guards', async () => {
    const current = account('u-heartbeat-lease-token');
    await insertDeleted(current);
    const id = await insertJob(current, 'routine.stop', 'routine-1', {
      status: 'running',
      attempts: 2,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    await pool.query(
      `UPDATE account_deletion_jobs
       SET lease_until=date_trunc('milliseconds',now())
         + interval '5 minutes' + interval '123 microseconds'
       WHERE id=$1`,
      [id],
    );
    const claimed = await job(id);
    const staleCopy = { ...claimed };
    const { jobs } = compose();

    await expect(jobs.assertCurrent(claimed)).resolves.toBeUndefined();
    await expect(jobs.heartbeat(claimed)).resolves.toBe(true);

    await expect(jobs.assertCurrent(claimed)).resolves.toBeUndefined();
    await expect(jobs.assertCurrent(staleCopy)).resolves.toBeUndefined();
    await expect(jobs.assertCurrent({ ...claimed, attempts: claimed.attempts + 1 }))
      .rejects.toBeInstanceOf(DeletionCancelledError);
    expect(claimed.leaseUntil).toEqual((await rawJob(id)).lease_until);
  });

  it('assertCurrent принимает healthy job при heartbeat interleaving со stale local lease', async () => {
    const current = account('u-assert-heartbeat-race');
    await insertDeleted(current);
    const id = await insertJob(current, 'routine.stop', 'routine-1', {
      status: 'running',
      attempts: 2,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    const claimed = await job(id);
    const localViewBeforeHeartbeat = { ...claimed };
    await pool.query(
      `UPDATE account_deletion_jobs
       SET lease_until=date_trunc('milliseconds',now())
         + interval '5 minutes' + interval '456 microseconds'
       WHERE id=$1
         AND deletion_id=$2
         AND attempts=$3
         AND status='running'`,
      [id, claimed.deletionId, claimed.attempts],
    );
    const { jobs } = compose();

    await expect(jobs.assertCurrent(localViewBeforeHeartbeat)).resolves.toBeUndefined();
    await expect(jobs.assertCurrent({
      ...localViewBeforeHeartbeat,
      attempts: localViewBeforeHeartbeat.attempts + 1,
    })).rejects.toBeInstanceOf(DeletionCancelledError);
  });

  it('heartbeat/finish/fail с stale attempts не меняют newer job', async () => {
    const current = account('u-conditional-token');
    await insertDeleted(current);
    const id = await insertJob(current, 'routine.stop', 'routine-1', {
      status: 'running',
      attempts: 2,
      nextAttemptAt: new Date(Date.now() - 60_000),
      leaseUntil: new Date(Date.now() + 60_000),
    });
    const stale = await job(id);
    await pool.query(
      `UPDATE account_deletion_jobs
       SET attempts=3,lease_until=now()+interval '2 minutes',updated_at=now()
       WHERE id=$1`,
      [id],
    );
    const newer = await rawJob(id);
    const staleLease = stale.leaseUntil;
    const { jobs } = compose();

    await expect(jobs.heartbeat(stale)).resolves.toBe(false);
    expect(stale.leaseUntil).toEqual(staleLease);
    await expect(jobs.finish(stale)).resolves.toBe(false);
    await expect(jobs.fail(stale, 'external_5xx')).resolves.toBe(false);

    const untouched = await rawJob(id);
    expect(untouched.status).toBe('running');
    expect(untouched.attempts).toBe(3);
    expect(untouched.lease_until).toEqual(newer.lease_until);
    expect(untouched.updated_at).toEqual(newer.updated_at);
    expect(untouched.next_attempt_at).toEqual(newer.next_attempt_at);
    expect(untouched.completed_at).toBeNull();
    expect(untouched.last_error_kind).toBeNull();

    const currentJob = await job(id);
    await expect(jobs.heartbeat(currentJob)).resolves.toBe(true);
    expect((await rawJob(id)).lease_until.getTime())
      .toBeGreaterThan(newer.lease_until.getTime());
    await expect(jobs.finish(await job(id))).resolves.toBe(true);
    expect(await job(id)).toMatchObject({ status: 'done', leaseUntil: null });
    expect((await rawJob(id)).completed_at).toBeInstanceOf(Date);
  });

  it('cancelled не получает retry, а следующий ресурс всё равно выполняется', async () => {
    const current = account('u-cancelled');
    await insertDeleted(current);
    const cancelled = await insertJob(current, 'calendar.stop', 'cal-1', {
      nextAttemptAt: new Date(Date.now() - 120_000),
    });
    const next = await insertJob(current, 'routine.stop', 'routine-1');
    const { runner } = compose({
      'calendar.stop': async () => { throw new DeletionCancelledError(); },
      'routine.stop': async () => undefined,
    });

    await runner.runAccount(current.deletionId);

    const cancelledRaw = await rawJob(cancelled);
    expect(cancelledRaw.status).toBe('cancelled');
    expect(cancelledRaw.last_error_kind).toBe('cancelled');
    expect(cancelledRaw.lease_until).toBeNull();
    expect(cancelledRaw.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await job(next)).toMatchObject({ status: 'done' });
  });

  it('runner продлевает lease heartbeat каждые 30 секунд', async () => {
    jest.useFakeTimers();
    const current = account('u-heartbeat');
    const claimed: DeletionJobRow = {
      id: randomUUID(),
      deletionId: current.deletionId,
      userId: current.userId,
      resourceType: 'routine.stop',
      resourceKey: 'routine-1',
      phase: 'immediate',
      payload: {},
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
      lastErrorKind: null,
    };
    let releaseAdapter!: () => void;
    let claims = 0;
    const jobs = {
      claimNext: jest.fn(async () => ++claims === 1 ? claimed : null),
      heartbeat: jest.fn(async () => true),
      finish: jest.fn(async () => true),
      fail: jest.fn(async () => true),
      assertCurrent: jest.fn(async () => undefined),
    };
    const registry = new AccountDeletionRegistry();
    const execute = jest.fn(async () => new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    }));
    registry.register({ resourceTypes: ['routine.stop'], execute });
    const runner = new AccountDeletionRunner({} as PgService, jobs as any, registry);

    const running = runner.runAccount(current.deletionId);
    await jest.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(jobs.heartbeat).toHaveBeenCalledWith(claimed);

    releaseAdapter();
    await jest.advanceTimersByTimeAsync(0);
    await running;
    expect(jobs.finish).toHaveBeenCalledWith(claimed);
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it('transient heartbeat timeout даёт retry, а successful retry завершает job', async () => {
    jest.useFakeTimers();
    const current = account('u-heartbeat-timeout');
    const claimed: DeletionJobRow = {
      id: randomUUID(),
      deletionId: current.deletionId,
      userId: current.userId,
      resourceType: 'routine.stop',
      resourceKey: 'routine-1',
      phase: 'immediate',
      payload: {},
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
      lastErrorKind: null,
    };
    let releaseAdapter!: () => void;
    const claims: Array<DeletionJobRow | null> = [claimed, null, claimed, null];
    const timeout = Object.assign(new Error(PROVIDER_RAW), { code: 'ETIMEDOUT' });
    const jobs = {
      claimNext: jest.fn(async () => claims.shift() ?? null),
      heartbeat: jest.fn(async () => true).mockRejectedValueOnce(timeout),
      finish: jest.fn(async () => true),
      fail: jest.fn(async () => true),
      assertCurrent: jest.fn(async () => undefined),
    };
    const registry = new AccountDeletionRegistry();
    const execute = jest.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseAdapter = resolve;
      }))
      .mockResolvedValue(undefined);
    registry.register({ resourceTypes: ['routine.stop'], execute });
    const runner = new AccountDeletionRunner({} as PgService, jobs as any, registry);

    const firstRun = runner.runAccount(current.deletionId);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(30_000);
    releaseAdapter();
    await jest.advanceTimersByTimeAsync(0);
    await firstRun;

    expect(jobs.fail).toHaveBeenNthCalledWith(1, claimed, 'timeout');
    expect(jobs.fail).not.toHaveBeenCalledWith(claimed, 'cancelled');
    expect(jobs.finish).not.toHaveBeenCalled();

    const retry = runner.runAccount(current.deletionId);
    await jest.advanceTimersByTimeAsync(0);
    await retry;
    expect(jobs.finish).toHaveBeenCalledWith(claimed);
    expect(jobs.fail).toHaveBeenCalledTimes(1);
  });

  it('registry явно отклоняет duplicate/missing и assertReady проверяет весь каталог', () => {
    const registry = new AccountDeletionRegistry();
    const adapter: AccountDeletionAdapter = {
      resourceTypes: ['routine.stop', 'calendar.stop'],
      execute: async () => undefined,
    };
    registry.register(adapter);

    expect(registry.getExecutor('routine.stop')).toBe(adapter);
    expect(() => registry.getExecutor('push.purge')).toThrow('deletion_executor_missing');
    expect(() => registry.register({
      resourceTypes: ['calendar.stop', 'push.purge'],
      execute: async () => undefined,
    })).toThrow('deletion_executor_duplicate');
    expect(() => registry.getExecutor('push.purge')).toThrow('deletion_executor_missing');
    expect(() => registry.assertReady()).toThrow('deletion_registry_not_ready');

    registry.register({
      resourceTypes: [...DELETION_RESOURCE_TYPES].filter(
        (resourceType) => resourceType !== 'routine.stop' && resourceType !== 'calendar.stop',
      ),
      execute: async () => undefined,
    });
    expect(() => registry.assertReady()).not.toThrow();
  });
});
