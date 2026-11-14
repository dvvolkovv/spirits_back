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
 * Task 17B — contacts: redact вместо удаления shared history.
 *
 * contact_requests ссылается на стороны СОБСТВЕННЫМИ surrogate id
 * (requester_id/target_id → ai_profiles_consolidated.id, INTEGER без FK-
 * констрейнтов). Purge:
 *  1. находит surrogate id удалённого поколения (SELECT под generation
 *     predicate); нет profile shell — нечего очищать, тихий успех;
 *  2. очищает message → NULL у requests, где requester_id = этот surrogate.
 *     NULL (а не '') — каноническое «сообщения нет»: колонка nullable,
 *     ContactRequest.message уже типизирован string | null и читатели
 *     (listIncoming/listOutgoing, экраны фронта) обрабатывают null; ''
 *     выглядела бы как намеренно отправленное пустое сообщение.
 *
 * Строки contact_requests НЕ удаляются: заявка — shared history второго
 * участника (его listIncoming/listOutgoing и аудит статусов продолжают
 * работать). Status/created_at/resolved_at не трогаются, profile shell
 * (ai_profiles_consolidated) НЕ удаляется и surrogate id НЕ
 * переименовывается — phoneById/idByPhone и joins через
 * ai_profiles_consolidated.id остаются целыми. Чужие requests (в адрес
 * удалённого и между третьими) сохраняются полностью.
 *
 * Отдельного contacts.stop нет (union DeletionResourcesType закрыт):
 * pending-заявки удалённого остаются pending до resolve вторым участником —
 * это его входящая история; текст заявки уже очищен purge'ом, а новые заявки
 * удалённого блокирует active guard ContactsService.createRequest.
 *
 * Job пустой (payload {}, статический resourceKey 'contacts' — урок Task 11;
 * surrogate id вычисляется в execute из job.userId, в payload не кладётся).
 * Внешних вызовов нет — только SQL: один assertCurrent до записи, TOCTOU
 * закрывает generation predicate, повторный прогон идемпотентен (message уже
 * NULL — 0 изменённых строк, тихий успех, паттерн events/support).
 */

const CONTACTS_SURROGATE_SQL = `SELECT id FROM ai_profiles_consolidated
 WHERE user_id=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

const CONTACTS_REQUEST_REDACT_SQL = `UPDATE contact_requests SET message=NULL
 WHERE requester_id=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$2 AND u.state='deleted' AND u.deletion_id=$3)`;

export async function discoverContactsDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: contact_requests и профили
  // при планировании не читаются (message в план не поднимается).
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [{
      resourceType: 'contacts.purge',
      // Статический ключ (один job на аккаунт), без userId, по RESOURCE_KEY_RE.
      resourceKey: 'contacts',
      phase: 'purge',
      payload: {},
    }],
    skips: [],
  };
}

@Injectable()
export class ContactsAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['contacts.purge'];

  constructor(private readonly registry: AccountDeletionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'contacts.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    try {
      const surrogate = await ctx.db.query(
        CONTACTS_SURROGATE_SQL,
        [job.userId, job.deletionId],
      );
      // Нет profile shell этого поколения — нечего очищать (идемпотентный
      // тихий успех, паттерн support).
      if (surrogate.rows.length === 0) return;
      const requesterId = Number(surrogate.rows[0].id);
      await ctx.db.query(
        CONTACTS_REQUEST_REDACT_SQL,
        [requesterId, job.userId, job.deletionId],
      );
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
