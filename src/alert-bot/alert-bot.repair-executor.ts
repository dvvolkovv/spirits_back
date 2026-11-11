import * as childProcess from 'child_process';
import { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { maskSecrets } from './alert-bot.mask';
import { RepairJobRecord, RepairStore } from './alert-bot.repair-store';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timeout', 'cancelled', 'interrupted']);
const MAX_OUTPUT_BYTES = 65_536;

type ForcedOutcome = 'timeout' | 'cancelled';

interface ProcessState {
  interruptible: boolean;
  stdout: string;
  stderr: string;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  outcome: ForcedOutcome | null;
  finished: boolean;
  timeout: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  completion: Promise<void>;
  complete: () => void;
}

function appendCapped(previous: string, decodedChunk: string): string {
  const value = previous + decodedChunk;
  if (Buffer.byteLength(value) <= MAX_OUTPUT_BYTES) return value;
  const buffer = Buffer.from(value);
  let start = buffer.length - MAX_OUTPUT_BYTES;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function clampWaitSeconds(value: number): number {
  return Number.isFinite(value) ? Math.min(30, Math.max(0, value)) : 0;
}

export class AlertBotRepairExecutor {
  private readonly children = new Map<string, ChildProcess>();
  private readonly repairs = new Map<string, string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly processes = new Map<string, ProcessState>();
  private readonly cancellingRepairs = new Set<string>();
  private readonly repairChains = new Map<string, Promise<void>>();
  private stoppingAll = false;

  constructor(private readonly store: RepairStore) {}

  async start(jobId: string, rawCommand: string): Promise<void> {
    const job = await this.store.findJob(jobId);
    if (!job) throw new Error('job_not_found');
    const previous = this.repairChains.get(job.repairId) ?? Promise.resolve();
    const setup = previous.then(() => this.startRegistered(job, rawCommand));
    this.repairChains.set(job.repairId, setup.then(() => undefined, () => undefined));
    return setup;
  }

  private async startRegistered(job: RepairJobRecord, rawCommand: string): Promise<void> {
    const jobId = job.id;
    if (this.isCancelling(job.repairId)) {
      await this.cancelBeforeSpawn(jobId);
      throw new Error('repair_inactive');
    }
    if (!await this.store.markJobRunning(jobId)) {
      await this.store.finishJob(jobId, {
        status: 'cancelled', exitCode: null, stdout: '', stderr: '', failureKind: 'repair_inactive',
      });
      this.wake(jobId);
      throw new Error('repair_inactive');
    }
    if (this.isCancelling(job.repairId)) {
      await this.cancelBeforeSpawn(jobId);
      throw new Error('repair_inactive');
    }

    const child = this.spawn(job, rawCommand);
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    const state: ProcessState = {
      interruptible: job.interruptible,
      stdout: '',
      stderr: '',
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      outcome: null,
      finished: false,
      timeout: null,
      killTimer: null,
      completion,
      complete,
    };
    this.children.set(jobId, child);
    this.repairs.set(jobId, job.repairId);
    this.processes.set(jobId, state);

    child.stdout!.on('data', (chunk: Buffer) => {
      state.stdout = appendCapped(state.stdout, state.stdoutDecoder.write(chunk));
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      state.stderr = appendCapped(state.stderr, state.stderrDecoder.write(chunk));
    });
    child.once('error', (error) => {
      state.stderr = appendCapped(state.stderr, `${error.message}\n`);
      void this.finishProcess(jobId, 'failed', null, 'spawn_error').catch(() => undefined);
    });
    child.once('close', (code) => {
      state.stdout = appendCapped(state.stdout, state.stdoutDecoder.end());
      state.stderr = appendCapped(state.stderr, state.stderrDecoder.end());
      const repairId = this.repairs.get(jobId);
      const cancelled = state.interruptible && repairId !== undefined && this.isCancelling(repairId);
      const status = state.outcome ?? (cancelled ? 'cancelled' : (code === 0 ? 'succeeded' : 'failed'));
      void this.finishProcess(jobId, status, code).catch(() => undefined);
    });

    if (job.host !== 'prod') {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(rawCommand);
    }
    state.timeout = setTimeout(() => {
      void this.terminate(jobId, 'timeout').catch(() => undefined);
    }, job.timeoutMs);
    state.timeout.unref();

    if (this.isCancelling(job.repairId) && job.interruptible) {
      void this.terminate(jobId, 'cancelled').catch(() => undefined);
    }
    const repair = await this.store.findRepair(job.repairId);
    const active = repair && ['requested', 'running'].includes(repair.status);
    if (!active && job.interruptible) {
      void this.terminate(jobId, 'cancelled').catch(() => undefined);
    }
  }

  async wait(jobId: string, waitSeconds: number): Promise<boolean> {
    const initial = await this.store.findJob(jobId);
    if (!initial) return false;
    if (TERMINAL_STATUSES.has(initial.status)) return true;
    const seconds = clampWaitSeconds(waitSeconds);
    if (seconds === 0) return false;

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const callbacks = this.waiters.get(jobId);
        callbacks?.delete(done);
        if (callbacks?.size === 0) this.waiters.delete(jobId);
        resolve();
      };
      const callbacks = this.waiters.get(jobId) ?? new Set<() => void>();
      callbacks.add(done);
      this.waiters.set(jobId, callbacks);
      timer = setTimeout(done, seconds * 1000);
      void this.store.findJob(jobId).then((job) => {
        if (!job || TERMINAL_STATUSES.has(job.status)) done();
      }).catch(done);
    });

    const current = await this.store.findJob(jobId);
    return Boolean(current && TERMINAL_STATUSES.has(current.status));
  }

  async stopRepair(repairId: string): Promise<void> {
    this.cancellingRepairs.add(repairId);
    let request: Promise<boolean>;
    try { request = this.store.requestCancel(repairId); }
    catch { request = Promise.resolve(false); }
    await request.catch(() => false);
    await this.repairChains.get(repairId);
    const jobs = [...this.repairs.entries()]
      .filter(([, currentRepairId]) => currentRepairId === repairId)
      .map(([jobId]) => jobId);
    await Promise.all(jobs.map((jobId) => this.terminate(jobId, 'cancelled')));
  }

  async stopAll(): Promise<void> {
    this.stoppingAll = true;
    for (const repairId of this.repairChains.keys()) this.cancellingRepairs.add(repairId);
    for (const repairId of this.repairs.values()) this.cancellingRepairs.add(repairId);
    await Promise.all([...this.repairChains.values()]);
    const jobs = [...this.processes.entries()]
      .filter(([, state]) => state.interruptible && !state.finished)
      .map(([jobId]) => jobId);
    await Promise.all(jobs.map((jobId) => this.terminate(jobId, 'cancelled')));
  }

  private spawn(job: RepairJobRecord, rawCommand: string): ChildProcess {
    if (job.host === 'prod') {
      return childProcess.spawn('bash', ['-lc', rawCommand], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    const destination = job.host === 'relay'
      ? process.env.ALERT_BOT_REPAIR_RELAY_SSH || 'dv@5.101.115.184'
      : process.env.ALERT_BOT_REPAIR_TEST_SSH || 'dv@85.192.61.231';
    return childProcess.spawn('ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', destination, 'bash', '-s',
    ], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  private isCancelling(repairId: string): boolean {
    return this.stoppingAll || this.cancellingRepairs.has(repairId);
  }

  private async cancelBeforeSpawn(jobId: string): Promise<void> {
    await this.store.finishJob(jobId, {
      status: 'cancelled', exitCode: null, stdout: '', stderr: '', failureKind: 'repair_inactive',
    });
    this.wake(jobId);
  }

  private signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }

  private async terminate(jobId: string, outcome: ForcedOutcome): Promise<void> {
    const state = this.processes.get(jobId);
    const child = this.children.get(jobId);
    if (!state || !child || (!state.interruptible && outcome !== 'timeout')) return;
    if (!state.finished && !state.outcome) {
      state.outcome = outcome;
      this.signalGroup(child, 'SIGTERM');
      state.killTimer = setTimeout(() => {
        if (!state.finished) this.signalGroup(child, 'SIGKILL');
      }, 5_000);
      state.killTimer.unref();
    }
    await state.completion;
  }

  private async finishProcess(
    jobId: string,
    status: 'succeeded' | 'failed' | 'timeout' | 'cancelled',
    exitCode: number | null,
    failureKind?: string,
  ): Promise<void> {
    const state = this.processes.get(jobId);
    if (!state || state.finished) return;
    state.finished = true;
    if (state.timeout) clearTimeout(state.timeout);
    if (state.killTimer) clearTimeout(state.killTimer);
    try {
      await this.store.finishJob(jobId, {
        status,
        exitCode,
        stdout: appendCapped('', maskSecrets(state.stdout)),
        stderr: appendCapped('', maskSecrets(state.stderr)),
        failureKind: failureKind ?? null,
      });
    } finally {
      state.complete();
      this.wake(jobId);
      this.children.delete(jobId);
      this.repairs.delete(jobId);
      this.processes.delete(jobId);
    }
  }

  private wake(jobId: string): void {
    const callbacks = [...(this.waiters.get(jobId) ?? [])];
    this.waiters.delete(jobId);
    callbacks.forEach((callback) => callback());
  }
}
