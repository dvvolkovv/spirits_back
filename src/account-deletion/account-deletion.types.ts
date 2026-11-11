export type DeletionOrigin = 'explicit' | 'merge';
export type DeletionPhase = 'immediate' | 'purge';
export type DeletionErrorKind =
  | 'timeout'
  | 'external_5xx'
  | 'external_4xx'
  | 'not_found'
  | 'permission'
  | 'rate_limited'
  | 'db'
  | 'external_unknown'
  | 'owner_unverifiable'
  | 'unsupported_external'
  | 'cancelled';

export interface DeletionJobSpec {
  resourceType: string;
  resourceKey: string;
  phase: DeletionPhase;
  payload: Record<string, unknown>;
}

export interface DeletionAccount {
  userId: string;
  deletionId: string;
  deletedAt: Date;
}

export interface DeletionDiscovery {
  account: DeletionAccount;
  origin: DeletionOrigin;
  db: {
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: any[]; rowCount?: number | null }>;
  };
}

export interface DeletionSkip {
  resourceType: string;
  reason: string;
}

export interface DeletionPlan {
  jobs: DeletionJobSpec[];
  skips: DeletionSkip[];
}

export interface DeletionJobRow extends DeletionJobSpec {
  id: string;
  deletionId: string;
  userId: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  lastErrorKind: DeletionErrorKind | null;
}

export interface DeletionExecution {
  db: DeletionDiscovery['db'];
  assertCurrent(job: DeletionJobRow): Promise<void>;
}

export interface AccountDeletionAdapter {
  readonly resourceTypes: readonly string[];
  execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void>;
}

export type DeletionDiscoverer = (ctx: DeletionDiscovery) => Promise<DeletionPlan>;
