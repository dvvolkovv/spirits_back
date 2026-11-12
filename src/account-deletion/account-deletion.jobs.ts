import { DeletionCancelledError } from './account-deletion.safe';
import type {
  DeletionDiscovery,
  DeletionJobRow,
} from './account-deletion.types';

type Db = DeletionDiscovery['db'];

export class AccountDeletionJobs {
  constructor(private readonly db: Db) {}

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
         AND j.lease_until IS NOT DISTINCT FROM $5::timestamptz`,
      [job.id, job.userId, job.deletionId, job.attempts, job.leaseUntil],
    );
    if (result.rowCount !== 1) throw new DeletionCancelledError();
  }
}
