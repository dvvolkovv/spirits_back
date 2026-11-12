import * as childProcess from 'child_process';
import { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { maskSecrets } from './alert-bot.mask';
import { FinishRepairJobResult, RepairJobRecord, RepairStore } from './alert-bot.repair-store';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timeout', 'cancelled', 'interrupted']);
const MAX_OUTPUT_BYTES = 65_536;
const MAX_RAW_OUTPUT_BYTES = 1_048_576;

type ForcedOutcome = 'timeout' | 'cancelled';

interface StreamBuffer {
  raw: string;
  bytes: number;
  overflow: boolean;
  decoder: StringDecoder;
}

export interface RepairStartResult {
  jobId: string;
  startError?: 'store_unavailable' | 'repair_inactive' | 'spawn_error';
}

interface ProcessState {
  host: RepairJobRecord['host'];
  interruptible: boolean;
  stdout: StreamBuffer;
  stderr: StreamBuffer;
  outcome: ForcedOutcome | null;
  finished: boolean;
  pending: FinishRepairJobResult | null;
  flushing: Promise<boolean> | null;
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

function createStreamBuffer(): StreamBuffer {
  return { raw: '', bytes: 0, overflow: false, decoder: new StringDecoder('utf8') };
}

function appendStream(stream: StreamBuffer, decodedChunk: string): void {
  stream.bytes += Buffer.byteLength(decodedChunk);
  if (stream.overflow) return;
  if (stream.bytes <= MAX_RAW_OUTPUT_BYTES) {
    stream.raw += decodedChunk;
    return;
  }
  stream.raw = '';
  stream.overflow = true;
}

function renderStream(stream: StreamBuffer): string {
  if (stream.overflow) return `[output_overflow:${stream.bytes} bytes]`;
  return appendCapped('', maskSecrets(stream.raw));
}

function clampWaitSeconds(value: number): number {
  return Number.isFinite(value) ? Math.min(30, Math.max(0, value)) : 0;
}

async function bounded(operation: Promise<unknown>, ms = 1_000): Promise<void> {
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
    ]);
  } finally { clearTimeout(timer!); }
}

function compensationJob(jobId: string, repairId: string): RepairJobRecord {
  return {
    id: jobId,
    repairId,
    sequence: 0,
    host: 'prod',
    command: '',
    kind: 'exec',
    mutates: false,
    interruptible: false,
    timeoutMs: 0,
    status: 'queued',
    exitCode: null,
    stdout: '',
    stderr: '',
    failureKind: null,
  };
}

export class AlertBotRepairExecutor {
  private readonly children = new Map<string, ChildProcess>();
  private readonly repairs = new Map<string, string>();
  private readonly jobRepairs = new Map<string, string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly processes = new Map<string, ProcessState>();
  private readonly cancellingRepairs = new Set<string>();
  private readonly repairChains = new Map<string, Promise<void>>();
  private readonly startCounts = new Map<string, number>();
  private stoppingAll = false;
  private stopAllEpoch = 0;

  constructor(private readonly store: RepairStore) {}

  registerJob(jobId: string, repairId: string): void {
    this.jobRepairs.set(jobId, repairId);
  }

  async start(jobId: string, rawCommand: string): Promise<RepairStartResult> {
    let repairId = this.jobRepairs.get(jobId);
    if (!repairId) {
      const registered = await this.store.findJob(jobId);
      if (!registered) throw new Error('job_not_found');
      repairId = registered.repairId;
      this.registerJob(jobId, repairId);
    }
    this.startCounts.set(repairId, (this.startCounts.get(repairId) ?? 0) + 1);
    const previous = this.repairChains.get(repairId) ?? Promise.resolve();
    const setup = previous.then(async (): Promise<RepairStartResult> => {
      if (this.processes.has(jobId)) {
        await this.flushTerminal(jobId);
        return { jobId };
      }
      let job: RepairJobRecord | null;
      try { job = await this.store.findJob(jobId); }
      catch {
        await this.finishPreSpawn(compensationJob(jobId, repairId), {
          status: 'interrupted', exitCode: null, stdout: '', stderr: '', failureKind: 'store_unavailable',
        });
        return { jobId, startError: 'store_unavailable' };
      }
      if (!job) throw new Error('job_not_found');
      return this.startRegistered(job, rawCommand);
    });
    this.repairChains.set(repairId, setup.then(() => undefined, () => undefined));
    void setup.then(
      () => this.completeStart(repairId),
      () => this.completeStart(repairId),
    );
    return setup;
  }

  private async startRegistered(job: RepairJobRecord, rawCommand: string): Promise<RepairStartResult> {
    const jobId = job.id;
    if (this.isCancelling(job.repairId)) {
      await this.cancelBeforeSpawn(job);
      return { jobId, startError: 'repair_inactive' };
    }
    let running: boolean;
    try { running = await this.store.markJobRunning(jobId); }
    catch {
      await this.finishPreSpawn(job, {
        status: 'interrupted', exitCode: null, stdout: '', stderr: '', failureKind: 'store_unavailable',
      });
      return { jobId, startError: 'store_unavailable' };
    }
    if (!running) {
      await this.finishPreSpawn(job, {
        status: 'cancelled', exitCode: null, stdout: '', stderr: '', failureKind: 'repair_inactive',
      });
      return { jobId, startError: 'repair_inactive' };
    }
    if (this.isCancelling(job.repairId)) {
      await this.cancelBeforeSpawn(job);
      return { jobId, startError: 'repair_inactive' };
    }

    let child: ChildProcess;
    try { child = this.spawn(job, rawCommand); }
    catch {
      await this.finishPreSpawn(job, {
        status: 'failed', exitCode: null, stdout: '', stderr: 'spawn_error\n', failureKind: 'spawn_error',
      });
      return { jobId, startError: 'spawn_error' };
    }
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    const state: ProcessState = {
      host: job.host,
      interruptible: job.interruptible,
      stdout: createStreamBuffer(),
      stderr: createStreamBuffer(),
      outcome: null,
      finished: false,
      pending: null,
      flushing: null,
      timeout: null,
      killTimer: null,
      completion,
      complete,
    };
    this.children.set(jobId, child);
    this.repairs.set(jobId, job.repairId);
    this.processes.set(jobId, state);

    child.stdout!.on('data', (chunk: Buffer) => {
      appendStream(state.stdout, state.stdout.decoder.write(chunk));
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      appendStream(state.stderr, state.stderr.decoder.write(chunk));
    });
    child.once('error', () => {
      appendStream(state.stderr, 'spawn_error\n');
      void this.finishProcess(jobId, 'failed', null, 'spawn_error').catch(() => undefined);
    });
    child.once('close', (code) => {
      appendStream(state.stdout, state.stdout.decoder.end());
      appendStream(state.stderr, state.stderr.decoder.end());
      if (job.host !== 'prod' && state.outcome === 'timeout') {
        void this.finishProcess(jobId, 'interrupted', null, 'remote_outcome_unknown').catch(() => undefined);
        return;
      }
      const repairId = this.repairs.get(jobId);
      const cancelled = job.host === 'prod' && state.interruptible && repairId !== undefined && this.isCancelling(repairId);
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
    let repair;
    try { repair = await this.store.findRepair(job.repairId); }
    catch {
      console.error('repair_secondary_check_failed');
      if (job.interruptible) void this.terminate(jobId, 'cancelled').catch(() => undefined);
      return { jobId };
    }
    const active = repair && ['requested', 'running'].includes(repair.status);
    if (!active && job.interruptible) {
      void this.terminate(jobId, 'cancelled').catch(() => undefined);
    }
    return { jobId };
  }

  async wait(jobId: string, waitSeconds: number): Promise<boolean> {
    const epoch = this.stopAllEpoch;
    if (this.processes.get(jobId)?.pending) await this.flushTerminal(jobId);
    const initial = await this.store.findJob(jobId);
    if (epoch !== this.stopAllEpoch) return false;
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

    if (this.processes.get(jobId)?.pending) await this.flushTerminal(jobId);
    const current = await this.store.findJob(jobId);
    return Boolean(current && TERMINAL_STATUSES.has(current.status));
  }

  async stopRepair(repairId: string): Promise<void> {
    this.cancellingRepairs.add(repairId);
    const early = this.terminateLocal(repairId);
    let request: Promise<boolean>;
    try { request = this.store.requestCancel(repairId); }
    catch { request = Promise.resolve(false); }
    await bounded(request);
    await bounded(this.repairChains.get(repairId) ?? Promise.resolve());
    const late = this.terminateLocal(repairId);
    await bounded(Promise.allSettled([early, late]));
    await bounded(this.flushPendingForRepair(repairId));
    await bounded(this.maybeCleanup(repairId));
  }

  async stopAll(): Promise<void> {
    this.stoppingAll = true;
    this.stopAllEpoch += 1;
    for (const repairId of this.repairChains.keys()) this.cancellingRepairs.add(repairId);
    for (const repairId of this.repairs.values()) this.cancellingRepairs.add(repairId);
    for (const jobId of [...this.waiters.keys()]) this.wake(jobId);
    const early = this.terminateLocal();
    await bounded(Promise.all([...this.repairChains.values()]));
    const late = this.terminateLocal();
    await bounded(Promise.allSettled([early, late]));
    await bounded(this.flushPendingForRepair());
    const repairs = new Set([...this.repairChains.keys(), ...this.cancellingRepairs.values()]);
    await bounded(Promise.all([...repairs].map((repairId) => this.maybeCleanup(repairId))));
  }

  private terminateLocal(repairId?: string): Promise<void> {
    const jobs = [...this.repairs.entries()]
      .filter(([jobId, currentRepairId]) => {
        const state = this.processes.get(jobId);
        return state?.host === 'prod' && state.interruptible && !state.finished
          && (repairId === undefined || currentRepairId === repairId);
      })
      .map(([jobId]) => jobId);
    return Promise.all(jobs.map((jobId) => this.terminate(jobId, 'cancelled'))).then(() => undefined);
  }

  private flushPendingForRepair(repairId?: string): Promise<void> {
    const jobs = [...this.repairs.entries()]
      .filter(([jobId, currentRepairId]) => this.processes.get(jobId)?.pending
        && (repairId === undefined || currentRepairId === repairId))
      .map(([jobId]) => jobId);
    return Promise.all(jobs.map((jobId) => this.flushTerminal(jobId))).then(() => undefined);
  }

  private spawn(job: RepairJobRecord, rawCommand: string): ChildProcess {
    if (job.host === 'prod') {
      return childProcess.spawn('bash', ['-lc', rawCommand], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    return childProcess.spawn('ssh', [
      ...this.sshPrefix(job.host), 'bash', '-s',
    ], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  private sshPrefix(host: 'relay' | 'test'): string[] {
    const destination = host === 'relay'
      ? process.env.ALERT_BOT_REPAIR_RELAY_SSH || 'dv@5.101.115.184'
      : process.env.ALERT_BOT_REPAIR_TEST_SSH || 'dv@85.192.61.231';
    return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', destination];
  }

  private isCancelling(repairId: string): boolean {
    return this.stoppingAll || this.cancellingRepairs.has(repairId);
  }

  private completeStart(repairId: string): void {
    const count = this.startCounts.get(repairId) ?? 0;
    if (count <= 1) this.startCounts.delete(repairId);
    else this.startCounts.set(repairId, count - 1);
    void this.maybeCleanup(repairId);
  }

  private async maybeCleanup(repairId: string): Promise<void> {
    if ((this.startCounts.get(repairId) ?? 0) > 0) return;
    if ([...this.repairs.values()].includes(repairId)) return;
    let repair;
    try { repair = await this.store.findRepair(repairId); }
    catch { return; }
    if ((this.startCounts.get(repairId) ?? 0) > 0) return;
    if ([...this.repairs.values()].includes(repairId)) return;
    this.repairChains.delete(repairId);
    if (repair && ['requested', 'running', 'cancel_requested'].includes(repair.status)) return;
    this.cancellingRepairs.delete(repairId);
  }

  private async cancelBeforeSpawn(job: RepairJobRecord): Promise<void> {
    await this.finishPreSpawn(job, {
      status: 'cancelled', exitCode: null, stdout: '', stderr: '', failureKind: 'repair_inactive',
    });
  }

  private async finishPreSpawn(job: RepairJobRecord, result: FinishRepairJobResult): Promise<void> {
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    const state: ProcessState = {
      host: job.host,
      interruptible: job.interruptible,
      stdout: createStreamBuffer(),
      stderr: createStreamBuffer(),
      outcome: null,
      finished: true,
      pending: result,
      flushing: null,
      timeout: null,
      killTimer: null,
      completion,
      complete,
    };
    this.repairs.set(job.id, job.repairId);
    this.processes.set(job.id, state);
    try { await this.flushTerminal(job.id); }
    finally { state.complete(); }
  }

  private signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }

  private async terminate(jobId: string, outcome: ForcedOutcome): Promise<void> {
    const state = this.processes.get(jobId);
    const child = this.children.get(jobId);
    if (!state || !child) return;
    if (state.host !== 'prod') {
      if (outcome === 'timeout' && !state.finished && !state.outcome) {
        state.outcome = 'timeout';
        this.signalGroup(child, 'SIGKILL');
      }
      return;
    }
    if (!state.interruptible && outcome !== 'timeout') return;
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
    status: 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'interrupted',
    exitCode: number | null,
    failureKind?: string,
  ): Promise<void> {
    const state = this.processes.get(jobId);
    if (!state || state.finished) return;
    state.finished = true;
    if (state.timeout) clearTimeout(state.timeout);
    if (state.killTimer) clearTimeout(state.killTimer);
    state.pending = {
      status,
      exitCode,
      stdout: renderStream(state.stdout),
      stderr: renderStream(state.stderr),
      failureKind: failureKind ?? null,
    };
    try { await this.flushTerminal(jobId); }
    finally { state.complete(); }
  }

  private flushTerminal(jobId: string): Promise<boolean> {
    const state = this.processes.get(jobId);
    if (!state?.pending) return Promise.resolve(false);
    if (state.flushing) return state.flushing;
    const flushing = this.flushPending(jobId, state);
    state.flushing = flushing;
    void flushing.then(() => {
      if (state.flushing === flushing) state.flushing = null;
    });
    return flushing;
  }

  private async flushPending(jobId: string, state: ProcessState): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let applied = false;
      try { applied = await this.store.finishJob(jobId, state.pending!); }
      catch { console.error('repair_finish_failed'); }
      if (applied) {
        this.confirmTerminal(jobId);
        return true;
      }
      try {
        const fresh = await this.store.findJob(jobId);
        if (fresh && TERMINAL_STATUSES.has(fresh.status)) {
          this.confirmTerminal(jobId);
          return true;
        }
      } catch { console.error('repair_finish_check_failed'); }
      if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    return false;
  }

  private confirmTerminal(jobId: string): void {
    const state = this.processes.get(jobId);
    const repairId = this.repairs.get(jobId);
    if (state) state.pending = null;
    this.children.delete(jobId);
    this.repairs.delete(jobId);
    this.jobRepairs.delete(jobId);
    this.processes.delete(jobId);
    this.wake(jobId);
    if (repairId) void this.maybeCleanup(repairId);
  }

  private wake(jobId: string): void {
    const callbacks = [...(this.waiters.get(jobId) ?? [])];
    this.waiters.delete(jobId);
    callbacks.forEach((callback) => callback());
  }
}
