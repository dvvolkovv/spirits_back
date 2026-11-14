import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import type {
  AccountDeletionAdapter,
  DeletionDiscovery,
  DeletionExecution,
  DeletionJobRow,
  DeletionPlan,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';

/**
 * Task 17C — retention/outreach: рассылки удалённым аккаунтам останавливаются.
 *
 * retention.stop — единственный job (union закрыт, 'retention.purge' нет):
 * у retention нет per-user персистентного состояния, которое нужно обратить —
 * удалённый аккаунт исключается из рассылок на уровне SQL:
 *  - GENERAL_SEGMENT_SQL / CURIOUS_SEGMENT_SQL (retention-sql.ts) джойнят
 *    user_id со state='active' — удалённый в сегмент не попадает;
 *  - RetentionRecipientResolver фильтрует state='active' (accounts) и через
 *    EXISTS (profiles/identities) — контакты удалённого не резолвятся;
 *  - RetentionService.send() делает повторную strict-проверку непосредственно
 *    перед транспортом (fail-closed при ошибке проверки: 'active_check_failed').
 *
 * execute — маркер фазы без записей: assertCurrent подтверждает поколение,
 * затем тихий успех. suppression list (retention_email_unsubscribes со
 * stateless-токенами) и security rate-limit TTL СОХРАНЯЮТСЯ: отписка
 * переживает удаление аккаунта — письма на освобождённый адрес продолжать
 * ходить не должны. Повторный execute идемпотентен (нет состояния — нечему
 * расходиться). Внешних вызовов нет.
 */

export async function discoverRetentionDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: retention-таблицы при
  // планировании не читаются.
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [
      {
        resourceType: 'retention.stop',
        // Статический ключ (по одному job на аккаунт), без userId, по RESOURCE_KEY_RE.
        resourceKey: 'retention',
        phase: 'immediate',
        payload: {},
      },
    ],
    skips: [],
  };
}

@Injectable()
export class RetentionAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['retention.stop'];

  constructor(private readonly registry: AccountDeletionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'retention.stop') {
      throw new Error('unsupported_deletion_resource');
    }

    // Маркер фазы: остановка рассылок обеспечена SQL-гейтами сегментов,
    // resolver'а и send-path (см. док адаптера) — per-user записей нет,
    // suppression list и rate-limit TTL сохраняются.
    await ctx.assertCurrent(job);
  }
}
