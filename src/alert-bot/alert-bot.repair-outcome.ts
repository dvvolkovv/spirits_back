export type RepairModelOutcome = 'completed' | 'no_cause' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';
export type RepairFinalStatus = 'verified' | 'unverified' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';

export interface RepairOutcomeJob {
  id: string;
  sequence: number;
  kind: 'exec' | 'verify';
  mutates: boolean;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';
  exitCode: number | null;
}

export function deriveRepairOutcome(jobs: RepairOutcomeJob[], model: RepairModelOutcome): { status: RepairFinalStatus; mutationCount: number } {
  const ordered = [...jobs].sort((a, b) => a.sequence - b.sequence);
  const mutationCount = ordered.filter((job) => job.kind === 'exec' && job.mutates).length;
  const lastMutation = ordered.map((job) => job.kind === 'exec' && job.mutates ? job.sequence : 0).reduce((a, b) => Math.max(a, b), 0);
  const lastSuccessfulVerification = ordered.map((job) => job.kind === 'verify' && job.status === 'succeeded' && job.exitCode === 0 ? job.sequence : 0).reduce((a, b) => Math.max(a, b), 0);
  const lastUnsuccessfulJob = ordered.map((job) => job.status === 'failed' || job.status === 'timeout' || job.status === 'cancelled' || job.status === 'interrupted' ? job.sequence : 0).reduce((a, b) => Math.max(a, b), 0);
  const hasNonTerminalJobs = ordered.some((job) => job.status === 'queued' || job.status === 'running');
  const hasInterruptedJobs = ordered.some((job) => job.status === 'interrupted');
  const verified = lastSuccessfulVerification > lastMutation && lastSuccessfulVerification > lastUnsuccessfulJob;

  if (hasNonTerminalJobs) return { status: 'interrupted', mutationCount };
  if (model === 'cancelled') return { status: 'cancelled', mutationCount };
  if (verified) return { status: 'verified', mutationCount };
  if (model === 'no_cause') return { status: 'failed', mutationCount };
  if (model !== 'completed') return { status: model, mutationCount };
  if (hasInterruptedJobs) return { status: 'interrupted', mutationCount };
  if (lastUnsuccessfulJob > 0) return { status: 'failed', mutationCount };
  return { status: 'unverified', mutationCount };
}

export function repairStatusText(status: RepairFinalStatus, mutationCount: number, noCause = false): string {
  if (status === 'verified') return mutationCount ? 'Исправлено и проверено' : 'Проверено: исправление не потребовалось';
  if (status === 'unverified') return 'Выполнено, результат не подтверждён';
  if (status === 'failed') return noCause && !mutationCount ? 'Не исправлено: причина не подтверждена' : 'Не исправлено';
  if (status === 'timeout') return 'Не исправлено: время истекло';
  if (status === 'cancelled') return 'Исправление остановлено админом';
  return 'Исход неизвестен: исправление прервано';
}
