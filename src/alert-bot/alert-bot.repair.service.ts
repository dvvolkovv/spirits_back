import { Injectable } from '@nestjs/common';
import { isAlertBotRepairAdmin } from './alert-bot.config';
import { AlertBotRetryableError } from './alert-bot.errors';
import { maskText } from './alert-bot.mask';
import { AlertBotRepairAi } from './alert-bot.repair-ai';
import { AlertBotRepairExecutor } from './alert-bot.repair-executor';
import {
  deriveRepairOutcome, RepairModelOutcome, repairStatusText,
} from './alert-bot.repair-outcome';
import { AdmitRepairInput, RepairStore } from './alert-bot.repair-store';
import { TurnInput } from './alert-bot.types';

export interface RepairRunResult {
  text: string;
  costUsd: number;
  tools: string[];
  turnStatus: 'ok' | 'timeout' | 'error';
}

@Injectable()
export class AlertBotRepairService {
  private readonly controllers = new Map<string, AbortController>();

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

  async stop(chatId: string, tgId: string): Promise<string> {
    if (!isAlertBotRepairAdmin(tgId)) return 'Доступ только для администраторов';
    const active = await this.store.findActiveRepair(chatId);
    if (!active) return 'Нет активного исправления';
    await this.store.requestCancel(active.id);
    this.controllers.get(active.id)?.abort();
    await this.executor.stopRepair(active.id);
    return 'Исправление остановлено';
  }

  async stopAll(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await this.executor.stopAll();
  }

  async run(
    repairId: string,
    turnId: string,
    input: TurnInput,
    history: Array<{ question: string; answer: string }> = [],
  ): Promise<RepairRunResult> {
    const existing = await this.store.findRepair(repairId);
    if (existing?.status === 'cancel_requested') {
      const finished = await this.store.finishRepair(repairId, 'cancelled', 0);
      if (!finished) throw new AlertBotRetryableError('repair_fenced');
      return {
        text: repairStatusText('cancelled', 0), costUsd: 0, tools: [], turnStatus: 'error',
      };
    }
    if (!await this.store.markRepairRunning(repairId, turnId)) {
      throw new AlertBotRetryableError('repair_not_requested');
    }

    const controller = new AbortController();
    this.controllers.set(repairId, controller);
    let model: RepairModelOutcome = 'completed';
    let generated = { text: '', costUsd: 0, tools: [] as string[], noCause: false };
    try {
      generated = await this.ai.repair({
        ...input, history, mode: 'repair', repairId, turnId, signal: controller.signal,
      });
      if (generated.noCause) model = 'no_cause';
    } catch (error) {
      model = controller.signal.aborted
        ? 'cancelled'
        : (error as { kind?: unknown })?.kind === 'timeout' ? 'timeout' : 'failed';
    } finally {
      if (this.controllers.get(repairId) === controller) this.controllers.delete(repairId);
    }

    const jobs = await this.store.listJobs(repairId);
    const outcome = deriveRepairOutcome(jobs, model);
    const finished = await this.store.finishRepair(repairId, outcome.status, outcome.mutationCount);
    if (!finished) throw new AlertBotRetryableError('repair_fenced');
    const summary = generated.text.trim()
      || 'Модель завершилась без текстового пояснения; смотри служебный статус.';
    const turnStatus = outcome.status === 'verified' || outcome.status === 'unverified'
      ? 'ok'
      : outcome.status === 'timeout' ? 'timeout' : 'error';
    return {
      text: `${repairStatusText(outcome.status, outcome.mutationCount, generated.noCause)}\n${maskText(summary)}`,
      costUsd: generated.costUsd,
      tools: generated.tools,
      turnStatus,
    };
  }
}
