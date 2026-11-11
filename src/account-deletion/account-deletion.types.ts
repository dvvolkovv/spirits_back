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

export type DeletionResourceType =
  | 'account.core.immediate'
  | 'account.core.purge'
  | 'routine.stop'
  | 'routine.purge'
  | 'push.purge'
  | 'telegram.stop'
  | 'telegram.purge'
  | 'custom-agent.purge'
  | 'product.stop'
  | 'product.purge'
  | 'calendar.stop'
  | 'calendar.purge'
  | 'calendar.external'
  | 'integration.apple.stop'
  | 'integration.zoom.stop'
  | 'integration.talerid.stop'
  | 'voice.stop'
  | 'voice.purge'
  | 'voice-document.purge'
  | 'chat-file.purge'
  | 'image.purge'
  | 'video-job.purge'
  | 'video.provider'
  | 'speech.purge'
  | 'listen.purge'
  | 'avatar.purge'
  | 'elevenlabs-voice.purge'
  | 'events.purge'
  | 'tasks.stop'
  | 'tasks.purge'
  | 'support.stop'
  | 'support.purge'
  | 'peer.stop'
  | 'peer.purge'
  | 'contacts.purge'
  | 'referral.stop'
  | 'referral.purge'
  | 'retention.stop'
  | 'profile-backup.purge'
  | 'devices.purge'
  | 'guest-carry.stop'
  | 'guest.purge'
  | 'auth-verification.stop'
  | 'legacy-auth.purge'
  | 'legacy-smm.stop'
  | 'legacy-smm.purge';

export interface DeletionJobSpec {
  resourceType: DeletionResourceType;
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

export type DeletionSkipReason =
  | 'owner_unverifiable'
  | 'unsupported_external'
  | 'external_note_id_unavailable';

export interface DeletionSkip {
  resourceType: DeletionResourceType;
  reason: DeletionSkipReason;
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
  readonly resourceTypes: readonly DeletionResourceType[];
  execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void>;
}

export type DeletionDiscoverer = (ctx: DeletionDiscovery) => Promise<DeletionPlan>;
