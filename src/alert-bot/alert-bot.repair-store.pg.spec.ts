import { Pool } from 'pg';
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

  it('abandon отменяет только requested repair без turn', async () => {
    const requested = await admit('abandon-requested');
    expect(await store.abandon(requested)).toBe(true);
    expect(await store.abandon(requested)).toBe(false);
    expect((await store.findRepair(requested))).toMatchObject({
      status: 'cancelled', finishedAt: expect.any(Date),
    });

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
