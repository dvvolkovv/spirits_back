import * as childProcess from 'child_process';
import * as fs from 'fs';
import { AlertBotRepairExecutor } from './alert-bot.repair-executor';
import {
  CreateRepairJobInput,
  FinishRepairJobResult,
  RepairIdentityGuard,
  RepairJobRecord,
  RepairRecord,
  RepairStore,
} from './alert-bot.repair-store';

class MemoryRepairStore {
  readonly jobs = new Map<string, RepairJobRecord>();
  readonly repairs = new Map<string, RepairRecord>();
  private sequence = 0;

  constructor() {
    this.addRepair('repair-1');
  }

  addRepair(id: string): RepairRecord {
    const repair: RepairRecord = {
      id,
      updateId: this.repairs.size + 1,
      turnId: `turn-${id}`,
      chatId: `chat-${id}`,
      adminTgId: `admin-${id}`,
      instruction: 'безобидная проверка',
      status: 'requested',
      failureKind: null,
      mutationCount: 0,
      createdAt: new Date(),
      finishedAt: null,
    };
    this.repairs.set(id, repair);
    return repair;
  }

  async createJob(input: CreateRepairJobInput): Promise<{ id: string; sequence: number } | null> {
    const repair = this.repairs.get(input.repairId);
    if (!repair || !['requested', 'running'].includes(repair.status)) return null;
    if ([...this.jobs.values()].some((job) => job.repairId === input.repairId && ['queued', 'running'].includes(job.status))) {
      return null;
    }
    const id = `job-${++this.sequence}`;
    this.jobs.set(id, {
      id,
      repairId: input.repairId,
      sequence: this.sequence,
      host: input.host as RepairJobRecord['host'],
      command: input.command,
      kind: input.kind,
      mutates: input.mutates,
      interruptible: input.interruptible,
      timeoutMs: input.timeoutMs,
      status: 'queued',
      exitCode: null,
      stdout: '',
      stderr: '',
      failureKind: null,
    });
    return { id, sequence: this.sequence };
  }

  async findJob(id: string): Promise<RepairJobRecord | null> {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async findRepair(id: string): Promise<RepairRecord | null> {
    const repair = this.repairs.get(id);
    return repair ? { ...repair } : null;
  }

  async isActiveRepair(guard: RepairIdentityGuard): Promise<boolean> {
    const repair = this.repairs.get(guard.repairId);
    return Boolean(repair && ['requested', 'running'].includes(repair.status)
      && repair.turnId === guard.turnId && repair.chatId === guard.chatId && repair.adminTgId === guard.adminTgId);
  }

  async markJobRunning(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    const repair = job && this.repairs.get(job.repairId);
    if (!job || job.status !== 'queued' || !repair || !['requested', 'running'].includes(repair.status)) return false;
    job.status = 'running';
    return true;
  }

  async requestCancel(id: string): Promise<boolean> {
    const repair = this.repairs.get(id);
    if (!repair || !['requested', 'running'].includes(repair.status)) return false;
    repair.status = 'cancel_requested';
    return true;
  }

  async finishJob(id: string, result: FinishRepairJobResult): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || !['queued', 'running'].includes(job.status)) return false;
    job.status = result.status;
    job.exitCode = result.exitCode;
    job.stdout = result.stdout;
    job.stderr = result.stderr;
    job.failureKind = result.failureKind ?? null;
    return true;
  }

  asStore(): RepairStore {
    return this as unknown as RepairStore;
  }
}

describe('AlertBotRepairExecutor', () => {
  jest.setTimeout(15_000);

  let store: MemoryRepairStore;
  let executor: AlertBotRepairExecutor;

  beforeEach(() => {
    store = new MemoryRepairStore();
    executor = new AlertBotRepairExecutor(store.asStore());
  });

  afterEach(async () => {
    await executor.stopAll();
    jest.restoreAllMocks();
  });

  async function createJob(overrides: Partial<CreateRepairJobInput> = {}): Promise<RepairJobRecord> {
    const created = await store.createJob({
      repairId: 'repair-1',
      host: 'prod',
      command: 'redacted',
      kind: 'exec',
      mutates: true,
      interruptible: true,
      timeoutMs: 5_000,
      ...overrides,
    });
    if (!created) throw new Error('job not created');
    const job = await store.findJob(created.id);
    if (!job) throw new Error('job missing');
    return job;
  }

  it('сохраняет exit/stdout/stderr после асинхронного завершения', async () => {
    const job = await createJob();
    await executor.start(job.id, 'printf out; printf err >&2; exit 7');
    expect((await store.findJob(job.id))?.status).toBe('running');
    await executor.wait(job.id, 2);
    expect(await store.findJob(job.id)).toMatchObject({
      status: 'failed', exitCode: 7, stdout: 'out', stderr: 'err',
    });
  });

  it('bounded timeout завершает процессную группу', async () => {
    const spawned: childProcess.ChildProcess[] = [];
    const realSpawn = childProcess.spawn;
    jest.spyOn(childProcess, 'spawn').mockImplementation((...args: any[]) => {
      const child = realSpawn(...args as [any, any, any]);
      spawned.push(child);
      return child as any;
    });
    const job = await createJob({ timeoutMs: 50 });
    const startedAt = Date.now();
    await executor.start(job.id, 'sleep 30');
    await executor.wait(job.id, 2);
    expect(await store.findJob(job.id)).toMatchObject({ status: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(spawned[0]?.pid).toEqual(expect.any(Number));
    expect(() => process.kill(-spawned[0].pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });

  it('output ограничен 64 КБ и сохраняет UTF-8', async () => {
    const job = await createJob();
    await executor.start(job.id, "node -e \"process.stdout.write('я'.repeat(70000))\"");
    await executor.wait(job.id, 5);
    const done = await store.findJob(job.id);
    expect(Buffer.byteLength(done!.stdout)).toBeLessThanOrEqual(65_536);
    expect(done!.stdout).not.toContain('�');
  });

  it('markJobRunning=false отклоняет запуск без spawn и отменяет queued job', async () => {
    const job = await createJob();
    jest.spyOn(store, 'markJobRunning').mockResolvedValue(false);
    const spawn = jest.spyOn(childProcess, 'spawn');
    await expect(executor.start(job.id, 'printf no')).rejects.toThrow('repair_inactive');
    expect(spawn).not.toHaveBeenCalled();
    expect(await store.findJob(job.id)).toMatchObject({
      status: 'cancelled', failureKind: 'repair_inactive',
    });
  });

  it('после регистрации повторно видит cancel_requested и гасит interruptible child', async () => {
    const job = await createJob({ timeoutMs: 30_000 });
    const markRunning = store.markJobRunning.bind(store);
    jest.spyOn(store, 'markJobRunning').mockImplementation(async (id) => {
      const marked = await markRunning(id);
      if (marked) store.repairs.get('repair-1')!.status = 'cancel_requested';
      return marked;
    });
    await executor.start(job.id, 'sleep 30');
    await executor.wait(job.id, 2);
    expect(await store.findJob(job.id)).toMatchObject({ status: 'cancelled' });
  });

  it('noninterruptible после markJobRunning завершается сам даже при cancel_requested', async () => {
    const job = await createJob({ interruptible: false });
    const markRunning = store.markJobRunning.bind(store);
    jest.spyOn(store, 'markJobRunning').mockImplementation(async (id) => {
      const marked = await markRunning(id);
      if (marked) store.repairs.get('repair-1')!.status = 'cancel_requested';
      return marked;
    });
    await executor.start(job.id, 'printf survived');
    await executor.wait(job.id, 2);
    expect(await store.findJob(job.id)).toMatchObject({ status: 'succeeded', stdout: 'survived' });
  });

  it('stopRepair до start сохраняет cancellation marker даже при отказе requestCancel', async () => {
    const job = await createJob();
    jest.spyOn(store, 'requestCancel').mockResolvedValue(false);
    await executor.stopRepair('repair-1');
    const spawn = jest.spyOn(childProcess, 'spawn');
    await expect(executor.start(job.id, 'printf must-not-run')).rejects.toThrow('repair_inactive');
    expect(spawn).not.toHaveBeenCalled();
    expect(await store.findJob(job.id)).toMatchObject({ status: 'cancelled' });
  });

  it('stopRepair ждёт in-flight start и не даёт быстрому side effect запуститься после возврата', async () => {
    const job = await createJob();
    const sentinel = `/tmp/alert-bot-repair-start-stop-${process.pid}-${Date.now()}`;
    let releaseMark!: () => void;
    let markEntered!: () => void;
    const markGate = new Promise<void>((resolve) => { releaseMark = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const originalMark = store.markJobRunning.bind(store);
    jest.spyOn(store, 'markJobRunning').mockImplementation(async (id) => {
      const marked = await originalMark(id);
      markEntered();
      await markGate;
      return marked;
    });
    const spawn = jest.spyOn(childProcess, 'spawn');
    const observed = executor.start(job.id, `printf side-effect > ${sentinel}`).then(
      () => ({ status: 'resolved' as const }),
      (error) => ({ status: 'rejected' as const, error }),
    );
    await entered;
    const stopped = executor.stopRepair('repair-1');
    releaseMark();
    await stopped;
    expect((await observed).status).toBe('rejected');
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(await store.findJob(job.id)).toMatchObject({ status: 'cancelled' });

    const late = await createJob();
    await expect(executor.start(late.id, 'printf late-spawn')).rejects.toThrow('repair_inactive');
    expect(spawn).not.toHaveBeenCalled();
    fs.rmSync(sentinel, { force: true });
  });

  it('stopRepair останавливает только interruptible job указанного repair', async () => {
    store.addRepair('repair-2');
    const interrupted = await createJob({ timeoutMs: 30_000 });
    const untouched = await createJob({
      repairId: 'repair-2', interruptible: false, timeoutMs: 5_000,
    });
    await executor.start(interrupted.id, 'sleep 30');
    await executor.start(untouched.id, "node -e \"setTimeout(() => console.log('other-ok'), 150)\"");
    await executor.stopRepair('repair-1');
    await executor.wait(interrupted.id, 2);
    await executor.wait(untouched.id, 2);
    expect(await store.findJob(interrupted.id)).toMatchObject({ status: 'cancelled' });
    expect(await store.findJob(untouched.id)).toMatchObject({ status: 'succeeded', stdout: 'other-ok\n' });
  });

  it('stopAll останавливает interruptible jobs и не трогает noninterruptible', async () => {
    store.addRepair('repair-2');
    const interrupted = await createJob({ timeoutMs: 30_000 });
    const untouched = await createJob({ repairId: 'repair-2', interruptible: false });
    await executor.start(interrupted.id, 'sleep 30');
    await executor.start(untouched.id, "node -e \"setTimeout(() => console.log('survived-all'), 150)\"");
    await executor.stopAll();
    await executor.wait(interrupted.id, 2);
    await executor.wait(untouched.id, 2);
    expect(await store.findJob(interrupted.id)).toMatchObject({ status: 'cancelled' });
    expect(await store.findJob(untouched.id)).toMatchObject({ status: 'succeeded', stdout: 'survived-all\n' });
  });
});
