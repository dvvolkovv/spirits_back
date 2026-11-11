import { AlertBotRepairExecutor } from './alert-bot.repair-executor';
import { maskSecrets } from './alert-bot.mask';
import { RepairJobRecord, RepairStore } from './alert-bot.repair-store';
import { RepairIdentity } from './alert-bot.types';

const HOSTS = new Set(['prod', 'relay', 'test']);
const DEFAULT_TIMEOUT_MS = 1_200_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 1_800_000;
const MAX_COMMAND_BYTES = 32_768;

export interface RepairJobArgs {
  host: string;
  command: string;
  timeout_ms?: number;
  interruptible?: boolean;
  mutates?: boolean;
}

function timeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)));
}

function waitSeconds(value: number): number {
  return Number.isFinite(value) ? Math.min(30, Math.max(0, value)) : 0;
}

export class AlertBotRepairJobs {
  constructor(
    private readonly store: RepairStore,
    private readonly executor: AlertBotRepairExecutor,
  ) {}

  async start(ctx: RepairIdentity, kind: 'exec' | 'verify', args: RepairJobArgs): Promise<{ jobId: string }> {
    if (!HOSTS.has(args.host)) throw new Error('unknown_host');
    if (!await this.store.isActiveRepair(ctx)) throw new Error('repair_inactive');
    const rawCommand = args.command;
    if (typeof rawCommand !== 'string' || !rawCommand.trim() || rawCommand.includes('\0') || Buffer.byteLength(rawCommand) > MAX_COMMAND_BYTES) {
      throw new Error('invalid_command');
    }
    const created = await this.store.createJob({
      repairId: ctx.repairId,
      host: args.host,
      command: maskSecrets(rawCommand),
      kind,
      mutates: kind === 'exec' && args.mutates !== false,
      interruptible: args.interruptible === true,
      timeoutMs: timeoutMs(args.timeout_ms),
    });
    if (!created) {
      if (!await this.store.isActiveRepair(ctx)) throw new Error('repair_inactive');
      throw new Error('job_already_active');
    }
    this.executor.registerJob(created.id, ctx.repairId);
    await this.executor.start(created.id, rawCommand);
    return { jobId: created.id };
  }

  async wait(ctx: RepairIdentity, jobId: string, seconds: number): Promise<RepairJobRecord> {
    const job = await this.store.findJob(jobId);
    if (!job || job.repairId !== ctx.repairId) throw new Error('job_not_found');
    await this.executor.wait(jobId, waitSeconds(seconds));
    const current = await this.store.findJob(jobId);
    if (!current || current.repairId !== ctx.repairId) throw new Error('job_not_found');
    return current;
  }
}
