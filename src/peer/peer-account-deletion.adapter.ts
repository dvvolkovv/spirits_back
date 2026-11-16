import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionErrorKind,
} from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscovery,
  DeletionExecution,
  DeletionJobRow,
  DeletionPlan,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';

/**
 * Task 17B — peer: redact/tombstone вместо удаления shared history.
 *
 * peer.stop (immediate) переводит ИСХОДЯЩИЕ pending chat_requests поколения
 * в 'withdrawn' (статус из CHECK 001_peer_tables.sql; responded_at=now() —
 * как в PeerService.withdrawRequest). Входящие pending в адрес удалённого не
 * трогаются: это заявка другого человека, она остаётся его shared history до
 * purge-алиасинга. После stop новые отправки удалённого блокирует active guard
 * PeerService (sendRequest/sendMessage/block/report).
 *
 * peer.purge (после retention) — deletion-scoped alias 'deleted:<deletionId>'
 * вместо переименования user_id: user_id.internal_id и surrogate profile ID
 * (ai_profiles_consolidated.id) НЕ меняются. Строго по порядку:
 *  1. DELETE peer_messages WHERE sender_id — СВОИ сообщения удаляются,
 *     сообщения второго участника того же разговора сохраняются (FK на
 *     conversation не используется — cascade не задействуется);
 *  2. UPDATE chat_requests SET intro_message='' где from_user_id=userId —
 *     ДО алиасинга: после замены from_user_id на alias условие
 *     from_user_id=$1 уже не матчит свои строки, и intro осталось бы;
 *     чужие intro (входящие requests) сохраняются;
 *  3. alias ОБЕ стороны chat_requests (from/to) одним UPDATE c CASE;
 *  4. alias peer_conversations через LEAST/GREATEST(alias, other_id):
 *     CHECK (user_a_id < user_b_id) и UNIQUE(user_a_id,user_b_id) остаются
 *     валидными для партнёров с обеих сторон лексикографического порядка;
 *  5. DELETE исходящих user_blocks (blocker_id=userId) и alias входящих
 *     (blocked_id=userId): PK-коллизия невозможна — alias уникален на
 *     deletionId, CHECK blocker_id<>blocked_id сохраняется (blocker — живой);
 *  6. alias ОБЕ стороны user_reports (reporter_id/target_id), сохраняя
 *     reason/context_type/context_id и moderation-колонки (security-retention:
 *     жалоба — доказательство модерации, удаляется только идентичность).
 *
 * Все user-id колонки peer-схемы — TEXT без FK (001_peer_tables.sql), поэтому
 * alias не нарушает внешних ключей. request_id у peer_conversations (FK →
 * chat_requests ON DELETE SET NULL) не трогается: строки requests не удаляются.
 *
 * Job'ы пустые (payload {}, статический resourceKey 'peer' — урок Task 11;
 * deletionAlias вычисляется в execute из job.deletionId, в payload не
 * кладётся). Внешних вызовов нет — только SQL: один assertCurrent до записи,
 * TOCTOU закрывают generation predicate'ы внутри каждого statement, повторный
 * прогон идемпотентен (после первого alias условия *_id=$1 матчат 0 строк —
 * тихий успех, паттерн events/support).
 *
 * Порядок stop → purge обеспечивает DELETION_DEPENDENCIES
 * ('peer.purge': { allOf: ['peer.stop'] }): к моменту алиасинга собственных
 * pending-заявок уже нет, partial unique uniq_chat_requests_pending не видит
 * пар удалённого ни до, ни после alias.
 */

const PEER_STOP_SQL = `UPDATE chat_requests SET status='withdrawn', responded_at=now()
 WHERE from_user_id=$1 AND status='pending'
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

const PEER_MESSAGES_PURGE_SQL = `DELETE FROM peer_messages
 WHERE sender_id=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

const PEER_REQUEST_REDACT_SQL = `UPDATE chat_requests SET intro_message=''
 WHERE from_user_id=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

const PEER_REQUEST_ALIAS_SQL = `UPDATE chat_requests SET
   from_user_id=CASE WHEN from_user_id=$1 THEN $2 ELSE from_user_id END,
   to_user_id=CASE WHEN to_user_id=$1 THEN $2 ELSE to_user_id END
 WHERE (from_user_id=$1 OR to_user_id=$1)
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$3)`;

const PEER_CONVERSATION_ALIAS_SQL = `UPDATE peer_conversations
   SET user_a_id=LEAST($2,other_id), user_b_id=GREATEST($2,other_id)
  FROM (SELECT id, user_a_id AS other_id FROM peer_conversations WHERE user_b_id=$1
        UNION
        SELECT id, user_b_id AS other_id FROM peer_conversations WHERE user_a_id=$1) sides
 WHERE peer_conversations.id=sides.id
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$3)`;

const PEER_BLOCKS_OUTGOING_PURGE_SQL = `DELETE FROM user_blocks
 WHERE blocker_id=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

const PEER_BLOCKS_INCOMING_ALIAS_SQL = `UPDATE user_blocks SET blocked_id=$2
 WHERE blocked_id=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$3)`;

const PEER_REPORTS_ALIAS_SQL = `UPDATE user_reports SET
   reporter_id=CASE WHEN reporter_id=$1 THEN $2 ELSE reporter_id END,
   target_id=CASE WHEN target_id=$1 THEN $2 ELSE target_id END
 WHERE (reporter_id=$1 OR target_id=$1)
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$3)`;

export async function discoverPeerDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: peer-таблицы при
  // планировании не читаются (intro/контент сообщений в план не поднимаются).
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [
      {
        resourceType: 'peer.stop',
        // Статический ключ (по одному job на аккаунт), без userId, по RESOURCE_KEY_RE.
        resourceKey: 'peer',
        phase: 'immediate',
        payload: {},
      },
      {
        resourceType: 'peer.purge',
        resourceKey: 'peer',
        phase: 'purge',
        payload: {},
      },
    ],
    skips: [],
  };
}

@Injectable()
export class PeerAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['peer.stop', 'peer.purge'];

  constructor(private readonly registry: AccountDeletionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'peer.stop' && job.resourceType !== 'peer.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    try {
      if (job.resourceType === 'peer.stop') {
        await ctx.db.query(PEER_STOP_SQL, [job.userId, job.deletionId]);
        return;
      }
      // Deletion-scoped alias: только копии в peer-таблицах, internal_id и
      // surrogate profile ID не переименовываются.
      const deletionAlias = `deleted:${job.deletionId}`;
      // Порядок значим: intro_message чистится, пока from_user_id=userId ещё
      // матчит свои строки (после alias-UPDATE условие потеряется).
      await ctx.db.query(PEER_MESSAGES_PURGE_SQL, [job.userId, job.deletionId]);
      await ctx.db.query(PEER_REQUEST_REDACT_SQL, [job.userId, job.deletionId]);
      await ctx.db.query(PEER_REQUEST_ALIAS_SQL, [job.userId, deletionAlias, job.deletionId]);
      await ctx.db.query(PEER_CONVERSATION_ALIAS_SQL, [job.userId, deletionAlias, job.deletionId]);
      await ctx.db.query(PEER_BLOCKS_OUTGOING_PURGE_SQL, [job.userId, job.deletionId]);
      await ctx.db.query(PEER_BLOCKS_INCOMING_ALIAS_SQL, [job.userId, deletionAlias, job.deletionId]);
      await ctx.db.query(PEER_REPORTS_ALIAS_SQL, [job.userId, deletionAlias, job.deletionId]);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
