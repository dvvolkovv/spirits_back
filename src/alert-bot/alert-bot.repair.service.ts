import { Injectable } from '@nestjs/common';
import { isAlertBotRepairAdmin } from './alert-bot.config';
import { AlertBotRetryableError } from './alert-bot.errors';
import { maskText } from './alert-bot.mask';
import { AlertBotRepairAi } from './alert-bot.repair-ai';
import { AlertBotRepairExecutor } from './alert-bot.repair-executor';
import {
  deriveRepairOutcome, RepairFinalStatus, RepairModelOutcome, repairStatusText,
} from './alert-bot.repair-outcome';
import {
  AdmitRepairInput, RepairJobRecord, RepairRecord, RepairStore,
} from './alert-bot.repair-store';
import { TurnInput } from './alert-bot.types';

export interface RepairRunResult {
  text: string;
  costUsd: number;
  tools: string[];
  turnStatus: 'ok' | 'timeout' | 'error';
}

interface RepairGenerated {
  text: string;
  costUsd: number;
  tools: string[];
  noCause: boolean;
}

const TERMINAL_STATUSES = new Set<RepairRecord['status']>([
  'verified', 'unverified', 'failed', 'timeout', 'cancelled', 'interrupted',
]);

function emptyGenerated(): RepairGenerated {
  return { text: '', costUsd: 0, tools: [], noCause: false };
}

@Injectable()
export class AlertBotRepairService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly adminCancelledRepairs = new Set<string>();
  private stoppingAll = false;

  constructor(
    private readonly store: RepairStore,
    private readonly ai: AlertBotRepairAi,
    private readonly executor: AlertBotRepairExecutor,
  ) {}

  async admit(input: AdmitRepairInput) {
    return this.store.admitRepair(input);
  }

  async abandon(repairId: string): Promise<boolean> {
    return this.store.abandon(repairId);
  }

  async findRepairByUpdate(updateId: number): Promise<RepairRecord | null> {
    return this.store.findRepairByUpdate(updateId);
  }

  async stop(chatId: string, tgId: string): Promise<string> {
    if (!isAlertBotRepairAdmin(tgId)) return 'Доступ только для администраторов';
    const active = await this.store.findActiveRepair(chatId);
    if (!active) return 'Нет активного исправления';
    this.adminCancelledRepairs.add(active.id);
    const requested = await this.store.requestCancel(active.id);
    if (!requested) {
      const current = await this.store.findRepair(active.id);
      if (current && TERMINAL_STATUSES.has(current.status)) {
        this.adminCancelledRepairs.delete(active.id);
        return repairStatusText(current.status as RepairFinalStatus, current.mutationCount);
      }
      if (current?.status !== 'cancel_requested') {
        this.adminCancelledRepairs.delete(active.id);
        return 'Нет активного исправления';
      }
    }
    this.controllers.get(active.id)?.abort();
    await this.executor.stopRepair(active.id);
    return requested ? 'Исправление остановлено' : 'Исправление останавливается';
  }

  async stopAll(): Promise<void> {
    this.stoppingAll = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.executor.stopAll();
    for (const repairId of [...this.adminCancelledRepairs]) {
      try {
        const repair = await this.store.findRepair(repairId);
        if (repair && TERMINAL_STATUSES.has(repair.status)) this.adminCancelledRepairs.delete(repairId);
      } catch {
        // При сбое чтения marker сохраняется до успешной terminal финализации.
      }
    }
  }

  async run(
    repairId: string,
    turnId: string,
    input: TurnInput,
    history: Array<{ question: string; answer: string }> = [],
  ): Promise<RepairRunResult> {
    let generated = emptyGenerated();
    const existing = await this.store.findRepair(repairId);
    if (existing?.status === 'cancel_requested') {
      return this.finalize(repairId, [], this.cancelModel(repairId), generated, false);
    }
    if (!await this.store.markRepairRunning(repairId, turnId)) {
      const current = await this.store.findRepair(repairId);
      if (current?.status === 'cancel_requested' || this.stoppingAll || this.adminCancelledRepairs.has(repairId)) {
        return this.finalize(repairId, [], this.cancelModel(repairId), generated, false);
      }
      throw new AlertBotRetryableError('repair_not_requested');
    }

    const controller = new AbortController();
    this.controllers.set(repairId, controller);
    let model: RepairModelOutcome = 'completed';
    try {
      const current = await this.store.findRepair(repairId);
      if (this.stoppingAll || this.adminCancelledRepairs.has(repairId) || current?.status === 'cancel_requested') {
        controller.abort();
        model = this.cancelModel(repairId);
      } else {
        try {
          generated = await this.ai.repair({
            ...input, history, mode: 'repair', repairId, turnId, signal: controller.signal,
          });
          if (generated.noCause) model = 'no_cause';
        } catch (error) {
          model = controller.signal.aborted
            ? this.cancelModel(repairId)
            : (error as { kind?: unknown })?.kind === 'timeout' ? 'timeout' : 'failed';
        }
      }
    } finally {
      if (this.controllers.get(repairId) === controller) this.controllers.delete(repairId);
    }

    if (this.adminCancelledRepairs.has(repairId)) await this.executor.stopRepair(repairId);
    const jobs = await this.store.listJobs(repairId);
    const current = await this.store.findRepair(repairId);
    if (this.stoppingAll) model = 'interrupted';
    else if (this.adminCancelledRepairs.has(repairId) || current?.status === 'cancel_requested') {
      model = this.cancelModel(repairId);
    }
    return this.finalize(repairId, jobs, model, generated);
  }

  private cancelModel(repairId: string): RepairModelOutcome {
    if (this.stoppingAll) return 'interrupted';
    return this.adminCancelledRepairs.has(repairId) ? 'cancelled' : 'interrupted';
  }

  private async finalize(
    repairId: string,
    jobs: RepairJobRecord[],
    model: RepairModelOutcome,
    generated: RepairGenerated,
    includeSummary = true,
  ): Promise<RepairRunResult> {
    let outcome = deriveRepairOutcome(jobs, model);
    let finished = await this.store.finishRepair(repairId, outcome.status, outcome.mutationCount);
    if (!finished) {
      let current = await this.store.findRepair(repairId);
      if (current?.status === 'cancel_requested') {
        outcome = deriveRepairOutcome(jobs, this.cancelModel(repairId));
        finished = await this.store.finishRepair(repairId, outcome.status, outcome.mutationCount);
        if (!finished) current = await this.store.findRepair(repairId);
      }
      if (!finished) {
        if (!current || !TERMINAL_STATUSES.has(current.status)) {
          throw new AlertBotRetryableError('repair_fenced');
        }
        outcome = {
          status: current.status as RepairFinalStatus,
          mutationCount: current.mutationCount,
        };
      }
    }

    const status = repairStatusText(outcome.status, outcome.mutationCount, generated.noCause);
    const summary = generated.text.trim()
      || 'Модель завершилась без текстового пояснения; смотри служебный статус.';
    const turnStatus = outcome.status === 'verified' || outcome.status === 'unverified'
      ? 'ok'
      : outcome.status === 'timeout' ? 'timeout' : 'error';
    const text = includeSummary ? `${status}\n${maskText(summary)}` : status;
    this.adminCancelledRepairs.delete(repairId);
    return {
      text,
      costUsd: generated.costUsd,
      tools: generated.tools,
      turnStatus,
    };
  }
}
