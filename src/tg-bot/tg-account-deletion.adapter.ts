import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import type {
  AccountDeletionAdapter,
  DeletionDiscoverer,
  DeletionExecution,
  DeletionJobRow,
  DeletionJobSpec,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { inTransaction } from '../blog/blog-slot-claim';
import { PgService } from '../common/services/pg.service';
import { TgConfigService } from './tg-config.service';

/** Read-only snapshot: в persistent jobs попадают только технические ID. */
export const discoverTelegramDeletion: DeletionDiscoverer = async ({ db, account }) => {
  const configs = await db.query(
    `SELECT c.id,c.tg_chat_id FROM tg_bot_configs c WHERE c.owner_user_id=$1 ORDER BY c.id`,
    [account.userId],
  );
  const customAgents = await db.query(
    `SELECT ca.id FROM custom_agents ca WHERE ca.owner_user_id=$1 ORDER BY ca.id`,
    [account.userId],
  );
  const jobs: DeletionJobSpec[] = configs.rows.flatMap((row) => {
    const configId = String(row.id);
    return [
      {
        resourceType: 'telegram.stop' as const,
        resourceKey: configId,
        phase: 'immediate' as const,
        payload: { chatId: row.tg_chat_id == null ? null : String(row.tg_chat_id) },
      },
      {
        resourceType: 'telegram.purge' as const,
        resourceKey: configId,
        phase: 'purge' as const,
        payload: {},
      },
    ];
  });
  for (const row of customAgents.rows) {
    jobs.push({
      resourceType: 'custom-agent.purge',
      resourceKey: String(row.id),
      phase: 'purge',
      payload: {},
    });
  }
  return { jobs, skips: [] };
};

@Injectable()
export class TgAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = [
    'telegram.stop',
    'telegram.purge',
    'custom-agent.purge',
  ];

  constructor(
    private readonly pg: PgService,
    private readonly configs: TgConfigService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    switch (job.resourceType) {
      case 'telegram.stop':
        await ctx.assertCurrent(job);
        await this.pg.query(
          `UPDATE tg_claim_tokens t SET consumed_at=now()
           WHERE t.owner_user_id=$1 AND t.consumed_at IS NULL
             AND EXISTS (
               SELECT 1 FROM user_id u
               WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2
             )`,
          [job.userId, job.deletionId],
        );
        await this.pg.query(
          `UPDATE tg_bot_video_jobs tg
           SET delivery_status='failed',delivery_error='account_deleted'
           WHERE tg.config_id=$1 AND tg.delivery_status='pending'
             AND EXISTS (
               SELECT 1 FROM tg_bot_configs c
               JOIN user_id u ON u.internal_id=$2 AND u.state='deleted' AND u.deletion_id=$3
               WHERE c.id=tg.config_id AND c.owner_user_id=$2
             )`,
          [job.resourceKey, job.userId, job.deletionId],
        );
        await this.configs.archiveForAccountDeletion(
          job.resourceKey,
          job.userId,
          typeof job.payload.chatId === 'string' ? job.payload.chatId : null,
          job.deletionId,
        );
        return;
      case 'telegram.purge':
        await ctx.assertCurrent(job);
        await inTransaction(this.pg, async (tx) => {
          await tx.query(
            `DELETE FROM tg_claim_tokens t
             WHERE t.owner_user_id=$1
               AND EXISTS (
                 SELECT 1 FROM user_id u
                 WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2
               )`,
            [job.userId, job.deletionId],
          );
          await tx.query(
            `DELETE FROM tg_bot_messages m
             WHERE m.config_id=$1
               AND EXISTS (
                 SELECT 1 FROM tg_bot_configs c
                 JOIN user_id u ON u.internal_id=$2 AND u.state='deleted' AND u.deletion_id=$3
                 WHERE c.id=m.config_id AND c.owner_user_id=$2
               )`,
            [job.resourceKey, job.userId, job.deletionId],
          );
          await tx.query(
            `DELETE FROM tg_bot_configs c
             WHERE c.id=$1 AND c.owner_user_id=$2
               AND EXISTS (
                 SELECT 1 FROM user_id u
                 WHERE u.internal_id=$2 AND u.state='deleted' AND u.deletion_id=$3
               )`,
            [job.resourceKey, job.userId, job.deletionId],
          );
        });
        return;
      case 'custom-agent.purge':
        await ctx.assertCurrent(job);
        await this.pg.query(
          `DELETE FROM custom_agents ca
           WHERE ca.id=$1 AND ca.owner_user_id=$2
             AND NOT EXISTS (
               SELECT 1 FROM tg_bot_configs c WHERE c.custom_agent_id=ca.id
             )
             AND EXISTS (
               SELECT 1 FROM user_id u
               WHERE u.internal_id=$2 AND u.state='deleted' AND u.deletion_id=$3
             )`,
          [job.resourceKey, job.userId, job.deletionId],
        );
        return;
      default:
        throw new Error('unsupported_deletion_resource');
    }
  }
}
