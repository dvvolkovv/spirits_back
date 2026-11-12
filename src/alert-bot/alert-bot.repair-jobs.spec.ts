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

async function runTestSsh(script: string): Promise<{ code: number | null; stdout: string }> {
  const child = childProcess.spawn('ssh', [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'dv@85.192.61.231', 'bash', '-s',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stdin.end(script);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: stdout.trim() }));
  });
}

async function waitForRemoteFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await runTestSsh(`test -e ${path}`)).code === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('remote_pid_file_timeout');
}

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
    if ([...this.jobs.values()].some((job) => job.repairId === input.repairId
      && ['process_close_unconfirmed', 'remote_outcome_unknown'].includes(job.failureKind ?? ''))) return null;
    if ([...this.jobs.values()].some((job) => ['queued', 'running'].includes(job.status))) return null;
    const id = `job-${++this.sequence}`;
    this.jobs.set(id, {
      id, repairId: input.repairId, sequence: this.sequence, host: input.host as RepairJobRecord['host'],
      command: input.command, kind: input.kind, mutates: input.mutates, interruptible: input.interruptible,
      timeoutMs: input.timeoutMs, status: 'queued', exitCode: null, stdout: '', stderr: '', failureKind: null,
    });
    return { id, sequence: this.sequence };
  }

  async hasUnknownOutcome(repairId: string): Promise<boolean> {
    return [...this.jobs.values()].some((job) => job.repairId === repairId
      && ['process_close_unconfirmed', 'remote_outcome_unknown'].includes(job.failureKind ?? ''));
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

  async requestCancel(id: string): Promise<boolean> {
    if (id !== this.repair.id || !['requested', 'running'].includes(this.repair.status)) return false;
    this.repair.status = 'cancel_requested';
    return true;
  }

  async finishJob(id: string, result: FinishRepairJobResult): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || !['queued', 'running'].includes(job.status)) return false;
    Object.assign(job, result, { failureKind: result.failureKind ?? null });
    return true;
  }

  async finishUnknownAndCancelRepair(jobId: string, repairId: string, result: FinishRepairJobResult): Promise<boolean> {
    const finished = await this.finishJob(jobId, result);
    if (finished) await this.requestCancel(repairId);
    return finished;
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

  it('host:test /stop не убивает remote command и поздний sentinel появляется', async () => {
    const sentinel = `/tmp/alert-bot-repair-remote-stop-${process.pid}-${Date.now()}`;
    let settled = false;
    try {
      const started = await jobs.start(ctx, 'exec', {
        host: 'test', command: `trap '' HUP; sleep 0.3; touch ${sentinel}`, timeout_ms: 5_000,
      });
      await executor.stopRepair(ctx.repairId);
      expect(await jobs.wait(ctx, started.jobId, 3)).toMatchObject({ status: 'succeeded', exitCode: 0 });
      settled = true;
      await waitForRemoteFile(sentinel);
      expect((await runTestSsh(`test -e ${sentinel}`)).code).toBe(0);
      expect((await runTestSsh(`test ! -e /tmp/alert-bot-repair-${started.jobId}.pid && test ! -e /tmp/alert-bot-repair-${started.jobId}.cancel`)).code).toBe(0);
    } finally {
      if (!settled) await runTestSsh('sleep 3');
      await runTestSsh(`rm -f ${sentinel} /tmp/alert-bot-repair-*.pid /tmp/alert-bot-repair-*.cancel`);
    }
  });

  it('host:test timeout даёт interrupted/remote_outcome_unknown и поздний cleanup sentinel', async () => {
    const sentinel = `/tmp/alert-bot-repair-remote-timeout-${process.pid}-${Date.now()}`;
    let settled = false;
    try {
      const started = await jobs.start(ctx, 'exec', {
        host: 'test', command: `trap '' HUP; sleep 2; touch ${sentinel}`, timeout_ms: 50,
      });
      const done = await jobs.wait(ctx, started.jobId, 3);
      expect(done).toMatchObject({ status: 'interrupted', failureKind: 'remote_outcome_unknown' });
      expect(done.status).not.toBe('cancelled');
      expect(done.status).not.toBe('timeout');
      await waitForRemoteFile(sentinel);
      settled = true;
      expect((await runTestSsh(`test -e ${sentinel}`)).code).toBe(0);
      expect((await runTestSsh(`test ! -e /tmp/alert-bot-repair-${started.jobId}.pid && test ! -e /tmp/alert-bot-repair-${started.jobId}.cancel`)).code).toBe(0);
    } finally {
      if (!settled) await runTestSsh('sleep 3');
      await runTestSsh(`rm -f ${sentinel} /tmp/alert-bot-repair-*.pid /tmp/alert-bot-repair-*.cancel`);
    }
  });

  it('host:test сохраняет обычный exit7 и stdout/stderr без helper files', async () => {
    const started = await jobs.start(ctx, 'exec', {
      host: 'test', command: 'printf remote-out; printf remote-err >&2; exit 7',
    });
    expect(await jobs.wait(ctx, started.jobId, 3)).toMatchObject({
      status: 'failed', exitCode: 7, stdout: 'remote-out', stderr: 'remote-err',
    });
    expect((await runTestSsh(`test ! -e /tmp/alert-bot-repair-${started.jobId}.pid && test ! -e /tmp/alert-bot-repair-${started.jobId}.cancel`)).code).toBe(0);
  });

  it('host:test exit255 означает interrupted/remote_outcome_unknown', async () => {
    const started = await jobs.start(ctx, 'exec', { host: 'test', command: 'exit 255' });
    expect(await jobs.wait(ctx, started.jobId, 3)).toMatchObject({
      status: 'interrupted', failureKind: 'remote_outcome_unknown',
    });
  });

  it('remote interruptible:true отклоняется до createJob', async () => {
    const create = jest.spyOn(store, 'createJob');
    await expect(jobs.start(ctx, 'exec', { host: 'test', command: 'printf no', interruptible: true }))
      .rejects.toThrow('remote_not_interruptible');
    expect(create).not.toHaveBeenCalled();
  });

  it('stopRepair ждёт начальный findJob внутри per-repair chain', async () => {
    let releaseFind!: () => void;
    let findEntered!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFind = resolve; });
    const entered = new Promise<void>((resolve) => { findEntered = resolve; });
    const original = store.findJob.bind(store);
    jest.spyOn(store, 'findJob').mockImplementation(async (id) => {
      findEntered();
      await gate;
      return original(id);
    });
    const spawn = jest.spyOn(childProcess, 'spawn');
    const observed = jobs.start(ctx, 'exec', { host: 'prod', command: 'printf must-not-run' }).then(
      (value) => ({ status: 'resolved' as const, value }),
      (error) => ({ status: 'rejected' as const, error }),
    );
    await entered;
    let stopResolved = false;
    const stopped = executor.stopRepair(ctx.repairId).then(() => { stopResolved = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const resolvedBeforeRelease = stopResolved;
    releaseFind();
    await stopped;
    expect((await observed).status).toBe('resolved');
    expect((await observed as any).value).toMatchObject({ startError: 'repair_inactive' });
    expect(resolvedBeforeRelease).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect([...store.jobs.values()][0]).toMatchObject({ status: 'cancelled' });
  });

  it.each(['stopRepair', 'stopAll'] as const)('%s bounded при зависшем initial findJob chain', async (mode) => {
    let releaseFind!: () => void;
    let findEntered!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFind = resolve; });
    const entered = new Promise<void>((resolve) => { findEntered = resolve; });
    const original = store.findJob.bind(store);
    jest.spyOn(store, 'findJob').mockImplementation(async (id) => {
      findEntered();
      await gate;
      return original(id);
    });
    const spawn = jest.spyOn(childProcess, 'spawn');
    const starting = jobs.start(ctx, 'exec', { host: 'prod', command: 'printf must-not-run' });
    await entered;
    let resolved = false;
    const stopped = (mode === 'stopRepair' ? executor.stopRepair(ctx.repairId) : executor.stopAll())
      .then(() => { resolved = true; });
    let timer: NodeJS.Timeout;
    await Promise.race([stopped, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); })]);
    clearTimeout(timer!);
    const bounded = resolved;
    releaseFind();
    await stopped;
    expect(bounded).toBe(true);
    expect(await starting).toMatchObject({ startError: 'repair_inactive' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['findJob', 'markJobRunning'] as const)('%s rejection и transient finish error возвращают jobId/startError и durable compensation', async (kind) => {
    const originalOperation = kind === 'findJob' ? store.findJob.bind(store) : store.markJobRunning.bind(store);
    jest.spyOn(store, kind).mockRejectedValueOnce(new Error(`${kind} unavailable`)).mockImplementation(originalOperation as any);
    const originalFinish = store.finishJob.bind(store);
    jest.spyOn(store, 'finishJob').mockRejectedValueOnce(new Error('finish unavailable')).mockImplementation(originalFinish);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const spawn = jest.spyOn(childProcess, 'spawn');
    const started = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf must-not-run' });
    expect(started).toMatchObject({ jobId: expect.any(String), startError: 'store_unavailable' });
    expect(await jobs.wait(ctx, started.jobId, 0.5)).toMatchObject({
      status: 'interrupted', failureKind: 'store_unavailable',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['findJob', 'markJobRunning'] as const)('%s rejection и permanent finish error сохраняют pending и jobId', async (kind) => {
    const originalOperation = kind === 'findJob' ? store.findJob.bind(store) : store.markJobRunning.bind(store);
    jest.spyOn(store, kind).mockRejectedValueOnce(new Error(`${kind} unavailable`)).mockImplementation(originalOperation as any);
    jest.spyOn(store, 'finishJob').mockRejectedValue(new Error('permanent finish unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const spawn = jest.spyOn(childProcess, 'spawn');
    const started = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf must-not-run' });
    expect(started).toMatchObject({ jobId: expect.any(String), startError: 'store_unavailable' });
    expect(await jobs.wait(ctx, started.jobId, 0.1)).toMatchObject({ status: 'queued' });
    expect((executor as any).processes.get(started.jobId)?.pending).toMatchObject({
      status: 'interrupted', failureKind: 'store_unavailable',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejected findJob и hanging finishJob возвращают startError с pending без второго flush', async () => {
    const original = store.findJob.bind(store);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(store, 'findJob').mockRejectedValueOnce(new Error('findJob unavailable')).mockImplementation(original);
    const finish = jest.spyOn(store, 'finishJob').mockImplementation(() => new Promise<boolean>(() => undefined));
    const starting = jobs.start(ctx, 'exec', { host: 'prod', command: 'printf must-not-run' });
    let timer: NodeJS.Timeout;
    const result = await Promise.race([
      starting,
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('start_hung'), 2_000); }),
    ]);
    clearTimeout(timer!);
    expect(result).toMatchObject({ startError: 'store_unavailable' });
    expect((executor as any).processes.get((result as any).jobId)?.pending).toBeTruthy();
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('periodic reconciliation восстанавливает pending после startError и stop', async () => {
    let dbDown = true;
    const originalMark = store.markJobRunning.bind(store);
    jest.spyOn(store, 'markJobRunning').mockRejectedValueOnce(new Error('mark unavailable')).mockImplementation(originalMark);
    const originalFinish = store.finishJob.bind(store);
    jest.spyOn(store, 'finishJob').mockImplementation((id, result) =>
      dbDown ? Promise.reject(new Error('database down')) : originalFinish(id, result));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const started = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf must-not-run' });
    expect(started).toMatchObject({ startError: 'store_unavailable' });
    await executor.stopRepair(ctx.repairId);
    expect((executor as any).processes.get(started.jobId)?.pending).toBeTruthy();
    expect((executor as any).reconciliation).toBeTruthy();

    dbDown = false;
    store.repair.status = 'interrupted';
    await (executor as any).reconcile();
    expect(await jobs.wait(ctx, started.jobId, 0.5)).toMatchObject({
      status: 'interrupted', failureKind: 'store_unavailable',
    });
    expect((executor as any).jobRepairs.has(started.jobId)).toBe(false);
    expect((executor as any).repairChains.has(ctx.repairId)).toBe(false);
    expect((executor as any).cancellingRepairs.has(ctx.repairId)).toBe(false);
    await executor.stopAll();
    expect((executor as any).reconciliation).toBeNull();
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

  it('createJob=null повторно различает repair_inactive и job_already_active', async () => {
    jest.spyOn(store, 'createJob').mockResolvedValue(null);
    const active = jest.spyOn(store, 'isActiveRepair')
      .mockResolvedValue(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(jobs.start(ctx, 'exec', { host: 'prod', command: 'printf no' })).rejects.toThrow('repair_inactive');
    await expect(jobs.start(ctx, 'exec', { host: 'prod', command: 'printf no' })).rejects.toThrow('job_already_active');
    expect(active).toHaveBeenCalledTimes(4);
  });

  it.each(['process_close_unconfirmed', 'remote_outcome_unknown'] as const)('%s возвращает repair_outcome_unknown и не освобождает следующую job', async (failureKind) => {
    store.repair.status = 'running';
    const first = await store.createJob({
      repairId: ctx.repairId, host: 'prod', command: 'redacted', kind: 'exec', mutates: true,
      interruptible: true, timeoutMs: 5_000,
    });
    await store.finishJob(first!.id, {
      status: 'interrupted', exitCode: null, stdout: '', stderr: '', failureKind,
    });
    store.repair.status = 'cancel_requested';
    const spawn = jest.spyOn(childProcess, 'spawn');
    await expect(store.createJob({
      repairId: ctx.repairId, host: 'prod', command: 'next', kind: 'exec', mutates: true,
      interruptible: true, timeoutMs: 5_000,
    })).resolves.toBeNull();
    await expect(jobs.start(ctx, 'exec', { host: 'prod', command: 'printf no' })).rejects.toThrow('repair_outcome_unknown');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('обычные failed/succeeded не блокируют следующую job', async () => {
    const input = {
      repairId: ctx.repairId, host: 'prod', command: 'redacted', kind: 'exec' as const,
      mutates: true, interruptible: true, timeoutMs: 5_000,
    };
    const failed = await store.createJob(input);
    await store.finishJob(failed!.id, { status: 'failed', exitCode: 1, stdout: '', stderr: '' });
    const succeeded = await store.createJob(input);
    expect(succeeded).not.toBeNull();
    await store.finishJob(succeeded!.id, { status: 'succeeded', exitCode: 0, stdout: '', stderr: '' });
    expect(await store.createJob(input)).not.toBeNull();
  });

  it.each(['', '   ', 'я'.repeat(20_000)])('отклоняет invalid_command без создания job', async (command) => {
    const create = jest.spyOn(store, 'createJob');
    await expect(jobs.start(ctx, 'exec', { host: 'prod', command })).rejects.toThrow('invalid_command');
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет command с NUL как invalid_command', async () => {
    const create = jest.spyOn(store, 'createJob');
    await expect(jobs.start(ctx, 'exec', { host: 'prod', command: 'printf before\0after' })).rejects.toThrow('invalid_command');
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

  it('маскирует named-env и URL secrets в command/stdout/stderr', async () => {
    const raw = `export JWT_SECRET="jwt-secret-value"; export DB_PASSWORD='db-password'; ` +
      `printf 'JWT_SECRET=%s\\nDB_PASSWORD=%s\\n' "$JWT_SECRET" "$DB_PASSWORD"; ` +
      `printf "api_key='first second third'\\nDATABASE_URL=postgres://user:url-secret@host/db" >&2`;
    const job = await jobs.start(ctx, 'exec', { host: 'prod', command: raw });
    const done = await jobs.wait(ctx, job.jobId, 2);
    expect(done.status).toBe('succeeded');
    const persisted = JSON.stringify([...store.jobs.values()]);
    for (const secret of ['jwt-secret-value', 'db-password', 'first', 'second', 'third', 'url-secret']) {
      expect(JSON.stringify(done)).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
    expect(done.stdout).toBe('JWT_SECRET=[скрыто]\nDB_PASSWORD=[скрыто]\n');
    expect(done.stderr).toContain('api_key=[скрыто]');
    expect(done.stderr).toContain('DATABASE_URL=postgres://user:[скрыто]@host/db');
  });

  it('wait сразу возвращает terminal job и не ждёт requested timeout', async () => {
    const job = await jobs.start(ctx, 'exec', { host: 'prod', command: 'printf done' });
    await jobs.wait(ctx, job.jobId, 2);
    const startedAt = Date.now();
    expect(await jobs.wait(ctx, job.jobId, 30)).toMatchObject({ status: 'succeeded', stdout: 'done' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
