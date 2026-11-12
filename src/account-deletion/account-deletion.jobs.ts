import { DELETION_DEPENDENCIES } from './account-deletion.catalog';
import {
  ACCOUNT_DELETION_RETENTION_MS,
  DeletionCancelledError,
  retryDelayMs,
} from './account-deletion.safe';
import type {
  DeletionAccount,
  DeletionDiscovery,
  DeletionErrorKind,
  DeletionJobRow,
  DeletionOrigin,
  DeletionResourceType,
} from './account-deletion.types';

type Db = DeletionDiscovery['db'];

export function mapDeletionJob(row: any): DeletionJobRow {
  return {
    id: row.id,
    deletionId: row.deletion_id,
    userId: row.user_id,
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    phase: row.phase,
    payload: row.payload_jsonb,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until,
    lastErrorKind: row.last_error_kind ?? null,
  };
}

function dependencyEligibilitySql(): string {
  const clauses: string[] = [];
  const entries = Object.entries(DELETION_DEPENDENCIES) as Array<[
    DeletionResourceType,
    NonNullable<(typeof DELETION_DEPENDENCIES)[DeletionResourceType]>,
  ]>;

  for (const [resourceType, rule] of entries) {
    const dependencies: string[] = [];
    if (rule.allStop) {
      dependencies.push(`NOT EXISTS (
        SELECT 1 FROM account_deletion_jobs d
        WHERE d.deletion_id=c.deletion_id
          AND d.resource_type LIKE '%.stop'
          AND d.status<>'done'
      )`);
    }
    for (const dependency of rule.allOf ?? []) {
      dependencies.push(`NOT EXISTS (
        SELECT 1 FROM account_deletion_jobs d
        WHERE d.deletion_id=c.deletion_id
          AND d.resource_type='${dependency}'
          AND d.status<>'done'
      )`);
    }
    for (const dependency of rule.sameResourceKey ?? []) {
      dependencies.push(`NOT EXISTS (
        SELECT 1 FROM account_deletion_jobs d
        WHERE d.deletion_id=c.deletion_id
          AND d.resource_type='${dependency}'
          AND d.resource_key=c.resource_key
          AND d.status<>'done'
      )`);
    }
    if (dependencies.length) {
      clauses.push(`(c.resource_type<>'${resourceType}' OR (${dependencies.join(' AND ')}))`);
    }
  }
  return clauses.length ? `AND ${clauses.join('\n        AND ')}` : '';
}

const DEPENDENCY_ELIGIBILITY_SQL = dependencyEligibilitySql();

export class AccountDeletionJobs {
  constructor(private readonly db: Db) {}

  async claimNext(deletionId?: string): Promise<DeletionJobRow | null> {
    const result = await this.db.query(
      `UPDATE account_deletion_jobs j
       SET status='running',attempts=j.attempts+1,
           lease_until=now()+interval '5 minutes',updated_at=now()
       WHERE j.id=(
         SELECT c.id
         FROM account_deletion_jobs c
         JOIN user_id u ON u.internal_id=c.user_id
           AND u.state='deleted'
           AND u.deletion_id=c.deletion_id
           AND u.deleted_at IS NOT NULL
         WHERE (($1::uuid IS NULL) OR c.deletion_id=$1)
           AND ((c.status IN ('pending','failed') AND c.next_attempt_at<=now())
             OR (c.status='running' AND c.lease_until<now()))
           ${DEPENDENCY_ELIGIBILITY_SQL}
         ORDER BY c.next_attempt_at,c.id
         LIMIT 1
         FOR UPDATE OF c SKIP LOCKED
       )
       RETURNING j.*`,
      [deletionId ?? null],
    );
    return result.rows[0] ? mapDeletionJob(result.rows[0]) : null;
  }

  async dueAccounts(
    after: [Date, string] | null,
    batchSize = 50,
    retentionMs = ACCOUNT_DELETION_RETENTION_MS,
  ): Promise<DeletionAccount[]> {
    const result = await this.db.query(
      `SELECT internal_id,deletion_id,deleted_at
       FROM user_id
       WHERE state='deleted'
         AND deletion_id IS NOT NULL
         AND deleted_at IS NOT NULL
         AND deleted_at<=now()-($4::bigint * interval '1 millisecond')
         AND ($1::timestamptz IS NULL OR (deleted_at,internal_id) > ($1,$2))
       ORDER BY deleted_at,internal_id
       LIMIT $3`,
      [after?.[0] ?? null, after?.[1] ?? null, batchSize, retentionMs],
    );
    return result.rows.map((row) => ({
      userId: row.internal_id,
      deletionId: row.deletion_id,
      deletedAt: row.deleted_at,
    }));
  }

  async originOf(account: DeletionAccount): Promise<DeletionOrigin> {
    const result = await this.db.query(
      `SELECT 1
       FROM account_deletion_jobs
       WHERE deletion_id=$1
         AND user_id=$2
         AND resource_type='account.core.immediate'
       LIMIT 1`,
      [account.deletionId, account.userId],
    );
    return result.rowCount === 1 ? 'explicit' : 'merge';
  }

  async heartbeat(job: DeletionJobRow): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE account_deletion_jobs
       SET lease_until=now()+interval '5 minutes',updated_at=now()
       WHERE id=$1
         AND deletion_id=$2
         AND attempts=$3
         AND status='running'`,
      [job.id, job.deletionId, job.attempts],
    );
    return result.rowCount === 1;
  }

  async finish(job: DeletionJobRow): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE account_deletion_jobs
       SET status='done',completed_at=now(),lease_until=NULL,
           last_error_kind=NULL,updated_at=now()
       WHERE id=$1
         AND deletion_id=$2
         AND attempts=$3
         AND status='running'`,
      [job.id, job.deletionId, job.attempts],
    );
    return result.rowCount === 1;
  }

  async fail(job: DeletionJobRow, kind: DeletionErrorKind): Promise<boolean> {
    if (kind === 'cancelled') {
      const result = await this.db.query(
        `UPDATE account_deletion_jobs
         SET status='cancelled',last_error_kind='cancelled',
             lease_until=NULL,updated_at=now()
         WHERE id=$1
           AND deletion_id=$2
           AND attempts=$3
           AND status='running'`,
        [job.id, job.deletionId, job.attempts],
      );
      return result.rowCount === 1;
    }

    const result = await this.db.query(
      `UPDATE account_deletion_jobs
       SET status='failed',last_error_kind=$4,
           next_attempt_at=now()+($5::bigint * interval '1 millisecond'),
           lease_until=NULL,updated_at=now()
       WHERE id=$1
         AND deletion_id=$2
         AND attempts=$3
         AND status='running'`,
      [job.id, job.deletionId, job.attempts, kind, retryDelayMs(job.attempts)],
    );
    return result.rowCount === 1;
  }

  async assertCurrent(job: DeletionJobRow): Promise<void> {
    const result = await this.db.query(
      `SELECT 1
       FROM account_deletion_jobs j
       JOIN user_id u ON u.internal_id=j.user_id
       WHERE j.id=$1
         AND j.user_id=$2
         AND j.deletion_id=$3
         AND u.deletion_id=$3
         AND u.state='deleted'
         AND j.status='running'
         AND j.attempts=$4
         AND $5::timestamptz IS NOT NULL
         AND j.lease_until IS NOT NULL
         AND j.lease_until > now()
         AND j.lease_until >= $5::timestamptz
         AND j.lease_until < $5::timestamptz + interval '1 millisecond'`,
      [job.id, job.userId, job.deletionId, job.attempts, job.leaseUntil],
    );
    if (result.rowCount !== 1) throw new DeletionCancelledError();
  }
}
