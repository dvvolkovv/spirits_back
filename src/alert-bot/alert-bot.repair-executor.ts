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
  processClosed: boolean;
  closed: Promise<void>;
  markClosed: () => void;
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

function remotePidFile(jobId: string): string {
  return `/tmp/alert-bot-repair-${jobId}.pid`;
}

function remoteCancelFile(jobId: string): string {
  return `/tmp/alert-bot-repair-${jobId}.cancel`;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class AlertBotRepairExecutor {
  private readonly children = new Map<string, ChildProcess>();
  private readonly repairs = new Map<string, string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly processes = new Map<string, ProcessState>();
  private readonly cancellingRepairs = new Set<string>();
  private readonly repairChains = new Map<string, Promise<void>>();
  private stoppingAll = false;
  private stopAllEpoch = 0;
  private remoteHelperDeadlineMs = 10_000;

  constructor(private readonly store: RepairStore) {}

  async start(jobId: string, rawCommand: string): Promise<string> {
    const job = await this.store.findJob(jobId);
    if (!job) throw new Error('job_not_found');
    if (this.processes.has(jobId)) {
      await this.flushTerminal(jobId);
      return jobId;
    }
    const previous = this.repairChains.get(job.repairId) ?? Promise.resolve();
    const setup = previous.then(() => this.startRegistered(job, rawCommand));
    this.repairChains.set(job.repairId, setup.then(() => undefined, () => undefined));
    return setup;
  }

  private async startRegistered(job: RepairJobRecord, rawCommand: string): Promise<string> {
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

    let child: ChildProcess;
    try { child = this.spawn(job, rawCommand); }
    catch {
      await this.store.finishJob(jobId, {
        status: 'failed', exitCode: null, stdout: '', stderr: 'spawn_error\n', failureKind: 'spawn_error',
      });
      this.wake(jobId);
      return jobId;
    }
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
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
      processClosed: false,
      closed,
      markClosed,
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
      state.processClosed = true;
      state.markClosed();
      appendStream(state.stdout, state.stdout.decoder.end());
      appendStream(state.stderr, state.stderr.decoder.end());
      const repairId = this.repairs.get(jobId);
      const cancelled = state.interruptible && repairId !== undefined && this.isCancelling(repairId);
      if (job.host !== 'prod' && (state.outcome || cancelled)) return;
      const status = state.outcome ?? (cancelled ? 'cancelled' : (code === 0 ? 'succeeded' : 'failed'));
      void this.finishProcess(jobId, status, code).catch(() => undefined);
    });

    if (job.host !== 'prod') {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(this.remotePayload(job, rawCommand));
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
      return jobId;
    }
    const active = repair && ['requested', 'running'].includes(repair.status);
    if (!active && job.interruptible) {
      void this.terminate(jobId, 'cancelled').catch(() => undefined);
    }
    return jobId;
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
    this.stopAllEpoch += 1;
    for (const repairId of this.repairChains.keys()) this.cancellingRepairs.add(repairId);
    for (const repairId of this.repairs.values()) this.cancellingRepairs.add(repairId);
    for (const jobId of [...this.waiters.keys()]) this.wake(jobId);
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
    return childProcess.spawn('ssh', [
      ...this.sshPrefix(job.host), 'setsid', '--wait', 'bash', '-s',
    ], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  private sshPrefix(host: 'relay' | 'test'): string[] {
    const destination = host === 'relay'
      ? process.env.ALERT_BOT_REPAIR_RELAY_SSH || 'dv@5.101.115.184'
      : process.env.ALERT_BOT_REPAIR_TEST_SSH || 'dv@85.192.61.231';
    return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', destination];
  }

  private remotePayload(job: RepairJobRecord, rawCommand: string): string {
    const pidFile = remotePidFile(job.id);
    const cancelFile = remoteCancelFile(job.id);
    const marker = `__ALERT_BOT_REPAIR_${job.id}__`;
    return [
      'umask 077',
      `if [ -e ${cancelFile} ]; then rm -f ${pidFile} ${cancelFile}; exit 0; fi`,
      `printf '%s\\n' "$$" > ${pidFile}`,
      `if [ -e ${cancelFile} ]; then rm -f ${pidFile} ${cancelFile}; exit 0; fi`,
      `bash -s <<'${marker}'`,
      rawCommand,
      marker,
      'status=$?',
      `rm -f ${pidFile} ${cancelFile}`,
      'exit "$status"',
      '',
    ].join('\n');
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
      if (state.host === 'prod') {
        this.signalGroup(child, 'SIGTERM');
        state.killTimer = setTimeout(() => {
          if (!state.finished) this.signalGroup(child, 'SIGKILL');
        }, 5_000);
        state.killTimer.unref();
      } else {
        void this.terminateRemote(jobId, state, child, outcome).catch(async () => {
          await this.finishProcess(jobId, 'interrupted', null, 'remote_cancel_unconfirmed');
        });
      }
    }
    await state.completion;
  }

  private async terminateRemote(
    jobId: string,
    state: ProcessState,
    child: ChildProcess,
    outcome: ForcedOutcome,
  ): Promise<void> {
    const stopOriginal = () => {
      if (!state.processClosed) this.signalGroup(child, 'SIGKILL');
    };
    await this.remoteCancelAndConfirm(state.host as 'relay' | 'test', jobId, state.processClosed, stopOriginal);
    if (!state.processClosed) {
      this.signalGroup(child, 'SIGKILL');
      await Promise.race([state.closed, delay(1_000)]);
    }
    const confirmed = await this.remoteCancelAndConfirm(state.host as 'relay' | 'test', jobId, true, stopOriginal);
    await this.finishProcess(
      jobId,
      confirmed ? outcome : 'interrupted',
      null,
      confirmed ? null : 'remote_cancel_unconfirmed',
    );
  }

  private async remoteCancelAndConfirm(
    host: 'relay' | 'test',
    jobId: string,
    originalClosed: boolean,
    onDeadline?: () => void,
  ): Promise<boolean> {
    const pidFile = remotePidFile(jobId);
    const cancelFile = remoteCancelFile(jobId);
    const script = [
      'umask 077',
      `: > ${cancelFile}`,
      'attempt=0',
      'while [ "$attempt" -lt 20 ]; do',
      `  if [ -s ${pidFile} ]; then break; fi`,
      `  if [ ! -e ${cancelFile} ]; then rm -f ${pidFile}; exit 0; fi`,
      '  attempt=$((attempt + 1))',
      '  sleep 0.1',
      'done',
      `if [ ! -s ${pidFile} ]; then`,
      originalClosed ? `  rm -f ${pidFile} ${cancelFile}; exit 0` : '  exit 2',
      'fi',
      `read -r pid < ${pidFile}`,
      `case "$pid" in ''|*[!0-9]*) exit 2;; esac`,
      'kill -TERM -- "-$pid" 2>/dev/null || true',
      'attempt=0',
      'while [ "$attempt" -lt 50 ]; do',
      '  if ! kill -0 -- "-$pid" 2>/dev/null; then',
      `    rm -f ${pidFile} ${cancelFile}`,
      '    exit 0',
      '  fi',
      '  attempt=$((attempt + 1))',
      '  sleep 0.1',
      'done',
      'kill -KILL -- "-$pid" 2>/dev/null || true',
      'attempt=0',
      'while [ "$attempt" -lt 10 ]; do',
      '  if ! kill -0 -- "-$pid" 2>/dev/null; then',
      `    rm -f ${pidFile} ${cancelFile}`,
      '    exit 0',
      '  fi',
      '  attempt=$((attempt + 1))',
      '  sleep 0.1',
      'done',
      'exit 1',
      '',
    ].join('\n');
    let child: ChildProcess;
    try {
      child = childProcess.spawn('ssh', [...this.sshPrefix(host), 'bash', '-s'], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch { return false; }
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(script);
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const done = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(confirmed);
      };
      timer = setTimeout(() => {
        try { this.signalGroup(child, 'SIGKILL'); } catch { /* helper уже недоступен */ }
        try { onDeadline?.(); } catch { /* original SSH уже недоступен */ }
        done(false);
      }, this.remoteHelperDeadlineMs);
      child.once('error', () => done(false));
      child.once('close', (code) => done(code === 0));
    });
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
    if (state) state.pending = null;
    this.children.delete(jobId);
    this.repairs.delete(jobId);
    this.processes.delete(jobId);
    this.wake(jobId);
  }

  private wake(jobId: string): void {
    const callbacks = [...(this.waiters.get(jobId) ?? [])];
    this.waiters.delete(jobId);
    callbacks.forEach((callback) => callback());
  }
}
