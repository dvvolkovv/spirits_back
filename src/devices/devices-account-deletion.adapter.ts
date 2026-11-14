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
 * Task 17D — user_devices: отпечатки устройств удалённого аккаунта.
 *
 * Несколько строк на пользователя (PK user_id+signature,
 * 001_user_devices.sql): purge удаляет ВСЕ строки по user_id под generation
 * predicate, включая raw_user_agent (сырые UA — часть device-идентичности).
 * Чужие устройства не затрагиваются.
 *
 * Job пустой (payload {}, статический resourceKey 'devices' — урок Task 11).
 * Внешних вызовов нет — только SQL: один assertCurrent до записи, TOCTOU
 * закрывает generation predicate внутри DELETE, повторный прогон идемпотентен
 * (0 строк — тихий успех, паттерн tasks/contacts).
 */

const DEVICES_PURGE_SQL = `DELETE FROM user_devices
 WHERE user_id=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

export async function discoverDevicesDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: user_devices при
  // планировании не читается (signature/raw_user_agent в план не поднимаются).
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [{
      resourceType: 'devices.purge',
      // Статический ключ (один job на аккаунт), без userId, по RESOURCE_KEY_RE.
      resourceKey: 'devices',
      phase: 'purge',
      payload: {},
    }],
    skips: [],
  };
}

@Injectable()
export class DevicesAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['devices.purge'];

  constructor(private readonly registry: AccountDeletionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'devices.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    try {
      await ctx.db.query(DEVICES_PURGE_SQL, [job.userId, job.deletionId]);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
