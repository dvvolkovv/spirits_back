import { Injectable } from '@nestjs/common';
import { maskSecrets } from './alert-bot.mask';
import { AlertBotRepairJobs, RepairJobArgs } from './alert-bot.repair-jobs';
import { AlertBotTools } from './alert-bot.tools';
import { OpsContext, OpsToolHandler, RepairIdentity } from './alert-bot.types';

const KNOWN_REPAIR_ERRORS = new Set([
  'unknown_host',
  'invalid_command',
  'repair_inactive',
  'repair_outcome_unknown',
  'remote_not_interruptible',
  'job_already_active',
  'job_not_found',
  'store_unavailable',
  'spawn_error',
]);

function safeRepairError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return KNOWN_REPAIR_ERRORS.has(code) ? code : 'tool_failed';
}

function repairContext(ctx: OpsContext): RepairIdentity | null {
  if (ctx.scope !== 'repair' || !ctx.repairId || !ctx.turnId || !ctx.adminTgId) return null;
  return ctx as RepairIdentity;
}

function repairToolText(value: unknown): string {
  const json = JSON.stringify(value, (_key, item) => typeof item === 'string' ? maskSecrets(item) : item) ?? 'null';
  if (Buffer.byteLength(json) <= 8192) return json;
  // Предварительный slice как в baseline toolText: посимвольное обрезание
  // полного JSON было бы O(n²) и блокировало бы event loop на секунды.
  let out = Array.from(json).slice(0, 7800).join('');
  while (Buffer.byteLength(`${out}\n…[обрезано]`) > 8192) out = Array.from(out).slice(0, -1).join('');
  return `${out}\n…[обрезано]`;
}

@Injectable()
export class AlertBotRepairTools implements OpsToolHandler {
  constructor(
    private readonly base: AlertBotTools,
    private readonly jobs: AlertBotRepairJobs,
  ) {}

  definitions(): Array<Record<string, unknown>> {
    const commandProperties = {
      host: { type: 'string', enum: ['prod', 'relay', 'test'] },
      command: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 1800000 },
      interruptible: { type: 'boolean' },
      mutates: { type: 'boolean' },
    };
    return [
      ...this.base.definitions(),
      {
        name: 'repair_exec',
        description: 'Запускает разрешённую команду исправления и возвращает jobId.',
        inputSchema: {
          type: 'object',
          required: ['host', 'command'],
          properties: commandProperties,
        },
      },
      {
        name: 'repair_job',
        description: 'Ожидает и возвращает свежую запись repair job.',
        inputSchema: {
          type: 'object',
          required: ['job_id'],
          properties: {
            job_id: { type: 'string' },
            wait_seconds: { type: 'integer', minimum: 0, maximum: 30 },
          },
        },
      },
      {
        name: 'repair_verify',
        description: 'Запускает проверку исправления и возвращает jobId.',
        inputSchema: {
          type: 'object',
          required: ['host', 'command'],
          properties: commandProperties,
        },
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: OpsContext,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!name.startsWith('repair_')) return this.base.execute(name, args, ctx, signal);
    const repairCtx = repairContext(ctx);
    if (!repairCtx) return repairToolText({ error: 'unknown_tool' });
    try {
      switch (name) {
        case 'repair_exec':
          return repairToolText(await this.jobs.start(repairCtx, 'exec', args as unknown as RepairJobArgs));
        case 'repair_verify':
          return repairToolText(await this.jobs.start(repairCtx, 'verify', args as unknown as RepairJobArgs));
        case 'repair_job':
          if (typeof args.job_id !== 'string') return repairToolText({ error: 'invalid_job_id' });
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.job_id)) {
            return repairToolText({ error: 'job_not_found' });
          }
          return repairToolText(await this.jobs.wait(
            repairCtx,
            args.job_id,
            typeof args.wait_seconds === 'number' ? args.wait_seconds : 0,
          ));
        default:
          return repairToolText({ error: 'unknown_tool' });
      }
    } catch (error) {
      return repairToolText({ error: safeRepairError(error) });
    }
  }
}
