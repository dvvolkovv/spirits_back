import * as childProcess from 'child_process';
import { AlertBotRepairExecutor } from './alert-bot.repair-executor';
import { AlertBotRepairJobs } from './alert-bot.repair-jobs';
import { maskSecrets } from './alert-bot.mask';
import {
  CreateRepairJobInput,
  FinishRepairJobResult,
  RepairIdentityGuard,
  RepairJobRecord,
  RepairRecord,
  RepairStore,
} from './alert-bot.repair-store';
import { RepairIdentity } from './alert-bot.types';

class MemoryRepairStore {
  readonly jobs = new Map<string, RepairJobRecord>();
  readonly repair: RepairRecord = {
    id: 'repair-1', updateId: 1, turnId: 'turn-1', chatId: 'chat-1', adminTgId: 'admin-1',
    instruction: 'безобидная проверка', status: 'requested', failureKind: null, mutationCount: 0,
    createdAt: new Date(), finishedAt: null,
  };
  private sequence = 0;

  async createJob(input: CreateRepairJobInput): Promise<{ id: string; sequence: number } | null> {
    if (!['requested', 'running'].includes(this.repair.status) || input.repairId !== this.repair.id) return null;
    if ([...this.jobs.values()].some((job) => ['queued', 'running'].includes(job.status))) return null;
    const id = `job-${++this.sequence}`;
    this.jobs.set(id, {
      id, repairId: input.repairId, sequence: this.sequence, host: input.host as RepairJobRecord['host'],
      command: input.command, kind: input.kind, mutates: input.mutates, interruptible: input.interruptible,
      timeoutMs: input.timeoutMs, status: 'queued', exitCode: null, stdout: '', stderr: '', failureKind: null,
    });
    return { id, sequence: this.sequence };
  }

  async findJob(id: string): Promise<RepairJobRecord | null> {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async findRepair(id: string): Promise<RepairRecord | null> {
    return id === this.repair.id ? { ...this.repair } : null;
  }

  async isActiveRepair(guard: RepairIdentityGuard): Promise<boolean> {
    return guard.repairId === this.repair.id && guard.turnId === this.repair.turnId
      && guard.chatId === this.repair.chatId && guard.adminTgId === this.repair.adminTgId
      && ['requested', 'running'].includes(this.repair.status);
  }

  async markJobRunning(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued' || !['requested', 'running'].includes(this.repair.status)) return false;
    job.status = 'running';
    return true;
  }

  async finishJob(id: string, result: FinishRepairJobResult): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || !['queued', 'running'].includes(job.status)) return false;
    Object.assign(job, result, { failureKind: result.failureKind ?? null });
    return true;
  }

  asStore(): RepairStore {
    return this as unknown as RepairStore;
  }
}

describe('AlertBotRepairJobs', () => {
  jest.setTimeout(15_000);

  const ctx: RepairIdentity = {
    scope: 'repair', repairId: 'repair-1', turnId: 'turn-1', chatId: 'chat-1',
    adminTgId: 'admin-1', adminUserId: 'admin-user-1',
  };
  let store: MemoryRepairStore;
  let executor: AlertBotRepairExecutor;
  let jobs: AlertBotRepairJobs;

  beforeEach(() => {
    store = new MemoryRepairStore();
    executor = new AlertBotRepairExecutor(store.asStore());
    jobs = new AlertBotRepairJobs(store.asStore(), executor);
  });

  afterEach(async () => {
    await executor.stopAll();
    jest.restoreAllMocks();
  });

  it('возвращает async job и сохраняет exit/stdout/stderr', async () => {
    const job = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf out; printf err >&2; exit 7', interruptible: true });
    expect(job).toEqual({ jobId: expect.any(String) });
    expect((await store.findJob(job.jobId))?.status).toBe('running');
    const done = await jobs.wait(ctx, job.jobId, 2);
    expect(done).toMatchObject({ status: 'failed', exitCode: 7, stdout: 'out', stderr: 'err' });
  });

  it('bounded timeout завершает процессную группу', async () => {
    const job = await jobs.start(ctx, 'exec', { host: 'prod', command: 'sleep 30', timeout_ms: 50, interruptible: true });
    const startedAt = Date.now();
    expect(await jobs.wait(ctx, job.jobId, 2)).toMatchObject({ status: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('unknown host и чужой repair не запускают spawn', async () => {
    const spawn = jest.spyOn(childProcess, 'spawn');
    await expect(jobs.start(ctx, 'exec', { host: 'other', command: 'printf no' })).rejects.toThrow('unknown_host');
    await expect(jobs.wait({ ...ctx, repairId: 'other' }, 'missing', 0)).rejects.toThrow('job_not_found');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('output ограничен 64 КБ и сохраняет UTF-8', async () => {
    const job = await jobs.start(ctx, 'exec', { host: 'prod', command: "node -e \"process.stdout.write('я'.repeat(70000))\"", timeout_ms: 5000 });
    const done = await jobs.wait(ctx, job.jobId, 5);
    expect(Buffer.byteLength(done.stdout)).toBeLessThanOrEqual(65_536);
    expect(done.stdout).not.toContain('�');
  });

  it('не создаёт job при repair_inactive', async () => {
    store.repair.status = 'cancel_requested';
    const spawn = jest.spyOn(childProcess, 'spawn');
    await expect(jobs.start(ctx, 'exec', { host: 'prod', command: 'printf no' })).rejects.toThrow('repair_inactive');
    expect(spawn).not.toHaveBeenCalled();
    expect(store.jobs.size).toBe(0);
  });

  it('возвращает job_already_active, пока предыдущая job не terminal', async () => {
    const first = await jobs.start(ctx, 'exec', { host: 'prod', command: 'sleep 30', interruptible: true });
    await expect(jobs.start(ctx, 'exec', { host: 'prod', command: 'printf no' })).rejects.toThrow('job_already_active');
    await executor.stopRepair(ctx.repairId);
    expect(await jobs.wait(ctx, first.jobId, 2)).toMatchObject({ status: 'cancelled' });
  });

  it.each(['', '   ', 'я'.repeat(20_000)])('отклоняет invalid_command без создания job', async (command) => {
    const create = jest.spyOn(store, 'createJob');
    await expect(jobs.start(ctx, 'exec', { host: 'prod', command })).rejects.toThrow('invalid_command');
    expect(create).not.toHaveBeenCalled();
  });

  it('ограничивает timeout и применяет default для неfinite значений', async () => {
    const low = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf low', timeout_ms: 1 });
    expect((await jobs.wait(ctx, low.jobId, 2)).timeoutMs).toBe(1_000);
    const high = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf high', timeout_ms: 9_999_999 });
    expect((await jobs.wait(ctx, high.jobId, 2)).timeoutMs).toBe(1_800_000);
    const omitted = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf default' });
    expect((await jobs.wait(ctx, omitted.jobId, 2)).timeoutMs).toBe(1_200_000);
    const notFinite = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf nan', timeout_ms: Number.NaN });
    expect((await jobs.wait(ctx, notFinite.jobId, 2)).timeoutMs).toBe(1_200_000);
  });

  it('передаёт дробный timeout_ms в store как trunc целого', async () => {
    const create = jest.spyOn(store, 'createJob');
    const job = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf fractional', timeout_ms: 1_234.9 });
    const done = await jobs.wait(ctx, job.jobId, 2);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1_234 }));
    expect(done.timeoutMs).toBe(1_234);
  });

  it('verify никогда не mutates, а exec учитывает mutates=false', async () => {
    const verify = await jobs.start(ctx, 'verify', { host: 'prod', command: 'printf verify', mutates: true });
    expect((await jobs.wait(ctx, verify.jobId, 2)).mutates).toBe(false);
    const exec = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf exec', mutates: false });
    expect((await jobs.wait(ctx, exec.jobId, 2)).mutates).toBe(false);
  });

  it('исполняет raw command, но сохраняет и возвращает только маскированные данные', async () => {
    const raw = "printf 'api_key=REAL_SECRET'; printf 'Bearer REAL.SECRET' >&2";
    const job = await jobs.start(ctx, 'exec', { host: 'prod', command: raw });
    const done = await jobs.wait(ctx, job.jobId, 2);
    expect(done).toMatchObject({
      status: 'succeeded', command: maskSecrets(raw),
      stdout: 'api_key=[скрыто]', stderr: 'Bearer [скрыто]',
    });
    expect(JSON.stringify([...store.jobs.values()])).not.toContain('REAL_SECRET');
    expect(JSON.stringify([...store.jobs.values()])).not.toContain('REAL.SECRET');

    const spawn = jest.spyOn(childProcess, 'spawn');
    const restartedExecutor = new AlertBotRepairExecutor(store.asStore());
    const restartedJobs = new AlertBotRepairJobs(store.asStore(), restartedExecutor);
    expect(await restartedJobs.wait(ctx, job.jobId, 0)).toMatchObject({ status: 'succeeded' });
    expect(spawn).not.toHaveBeenCalled();
    expect(done.command).toBe(maskSecrets(raw));
  });

  it('wait сразу возвращает terminal job и не ждёт requested timeout', async () => {
    const job = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf done' });
    await jobs.wait(ctx, job.jobId, 2);
    const startedAt = Date.now();
    expect(await jobs.wait(ctx, job.jobId, 30)).toMatchObject({ status: 'succeeded', stdout: 'done' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
