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
import { RedisService } from '../common/services/redis.service';
import { hashClaimer } from './guest-token';

/**
 * Task 17D — guest-trial: claimed-проба и carry-приписки удалённого аккаунта.
 *
 * guest-carry.stop (immediate) стирает Redis-приписки пробы
 * `guest-carry:<userId>:<assistantId>` (guest-carry.ts) префиксным
 * deleteByPrefix (курсорный SCAN + UNLINK, никогда KEYS). Приписка — пересказ
 * разговора до входа, адресуется по userId: это внешний (вне PG) ресурс без
 * generation predicate, поэтому поколение и lease перепроверяются
 * assertCurrent ДО и ПОСЛЕ операции (паттерн avatar). Magic-link 'ml-*' ключи
 * и SMS/security rate-limits НЕ трогаются: по аккаунту не адресуемы и относятся
 * к безопасности — гаснут естественным TTL.
 *
 * guest.purge (после retention) удаляет claimed-сессии guest_trial_sessions по
 * claimed_by_hash = hashClaimer(job.userId) — sha256('guest-claim:'+userId)
 * вычисляется В EXECUTE (payload пустой, урок Task 11). guest_trial_messages
 * исчезают существующим FK ON DELETE CASCADE (001_guest_trial.sql) — отдельного
 * SQL для сообщений нет.
 *
 * Unclaimed-сессии (claimed_by_hash IS NULL) не затрагиваются НИКОГДА: это
 * пробы других устройств, не связанные с аккаунтом (их убирает hourly cron
 * GuestSessionsService.purge по TTL). Глобальная guest_trial_settings не
 * выбирается никогда. Заметка A6: cron обнуляет claimed_by_hash через 7 дней
 * после переноса, а purge выполняется через 30+ — к этому моменту хеш обычно
 * уже обнулён (DELETE матчит 0 строк — тихий успех), поэтому guest.purge это
 * вторая линия защиты: она снимает claimed-строки, если уборка A6 не прошла.
 *
 * Правила DELETION_DEPENDENCIES не нужно: stop (immediate) и purge (после
 * retention) не разделяют состояние — Redis-приписка и строка сессии
 * независимы, фазы разведены по времени на 30 дней.
 *
 * Внешних вызовов (LLM/провайдеры) нет: SQL под generation predicate +
 * Redis-префикс, повторный прогон идемпотентен (0 строк / пустой SCAN —
 * тихий успех).
 */

const GUEST_PURGE_SQL = `DELETE FROM guest_trial_sessions
 WHERE claimed_by_hash=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$2 AND u.state='deleted' AND u.deletion_id=$3)`;

export async function discoverGuestDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: guest_trial_* при
  // планировании не читаются (content/claimed_by_hash в план не поднимаются).
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [
      {
        resourceType: 'guest-carry.stop',
        // Статический ключ (по одному job на аккаунт), без userId, по RESOURCE_KEY_RE.
        resourceKey: 'guest',
        phase: 'immediate',
        payload: {},
      },
      {
        resourceType: 'guest.purge',
        resourceKey: 'guest',
        phase: 'purge',
        payload: {},
      },
    ],
    skips: [],
  };
}

@Injectable()
export class GuestAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['guest-carry.stop', 'guest.purge'];

  constructor(
    private readonly redis: RedisService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'guest-carry.stop' && job.resourceType !== 'guest.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    if (job.resourceType === 'guest-carry.stop') {
      try {
        // Префикс собирается из job.userId (колонка job, не payload); форма
        // ключа — guestCarryKey (guest-carry.ts): `guest-carry:<userId>:<assistantId>`.
        await this.redis.deleteByPrefix(`guest-carry:${job.userId}:`);
      } catch (error) {
        if (error instanceof DeletionCancelledError) throw error;
        if (error instanceof DeletionRetryError) throw error;
        throw new DeletionRetryError(deletionErrorKind(error));
      }
      // Внешняя операция (Redis) могла занять время: перед тем как считать job
      // выполненным, поколение и lease перепроверяются (паттерн avatar).
      await ctx.assertCurrent(job);
      return;
    }
    try {
      await ctx.db.query(GUEST_PURGE_SQL, [
        hashClaimer(job.userId),
        job.userId,
        job.deletionId,
      ]);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
