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
 * Task 16 — обезличивание events при удалении аккаунта.
 *
 * events — продуктовая аналитика (воронки, /admin/monitoring/product): строки
 * НЕ удаляются, а обезличиваются — user_id/session_id/props стираются,
 * name/ts/source/cohort_week сохраняются как действительно анонимный агрегат.
 * Payments и security-логи не затрагиваются (это не events).
 *
 * Граница собственности — user_id или префикс session_id `<userId>_`
 * (LIKE $1 || '\_%' ESCAPE '\': похожий префикс 'u-deletedX_...' при userId
 * 'u-deleted' НЕ матчится). props не читаются вовсе: чужая referral-связь
 * (props.referee = удалённый id) сохраняется — props-only совпадения не
 * используются как ownership evidence.
 *
 * Job пустой (payload {}, статический resourceKey 'events' без userId):
 * цель целиком выводится из job.userId — урок Task 11 (произвольные строки
 * в payload не кладутся). Фаза строго 'purge': обезличивание после retention —
 * до очистки возможна реактивация. Generation predicate внутри UPDATE делает
 * исполнение идемпотентным (повторный прогон — 0 строк, тихий успех) и
 * безопасным после реактивации.
 *
 * Поздние записи из in-memory буфера блокирует фильтр EventsService.flush()
 * (state='deleted' по userId и session-префиксу, fail-closed) — поэтому
 * события удалённого аккаунта не воскресают после purge.
 */

const EVENTS_ANONYMIZE_SQL = `UPDATE events e SET user_id=NULL,session_id=NULL,props='{}'::jsonb
WHERE (e.user_id=$1 OR e.session_id LIKE $1 || '\\_%' ESCAPE '\\')
  AND EXISTS (SELECT 1 FROM user_id u
    WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

export async function discoverEventsDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: events.purge планируется,
  // лишь пока строка удалённого поколения на месте. Таблица events не
  // читается — props/name в план не поднимаются.
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [{
      resourceType: 'events.purge',
      // Статический ключ (один job на аккаунт), без userId, по RESOURCE_KEY_RE.
      resourceKey: 'events',
      phase: 'purge',
      payload: {},
    }],
    skips: [],
  };
}

@Injectable()
export class EventsAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['events.purge'];

  constructor(private readonly registry: AccountDeletionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'events.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    try {
      // Один scoped UPDATE под generation predicate. Внешних вызовов нет —
      // повторный assertCurrent после него не нужен (паттерн avatar/voice-avatar).
      await ctx.db.query(EVENTS_ANONYMIZE_SQL, [job.userId, job.deletionId]);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
