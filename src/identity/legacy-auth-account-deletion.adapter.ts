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

/**
 * Task 17D — legacy auth: verification-заслонки Redis и легаси short_codes.
 *
 * auth-verification.stop (immediate) стирает суточные заслонки
 * `ev-sent-<userId>-<sha256(email)[:16]>` (email.service.ts, «verification уже
 * предлагался») префиксным deleteByPrefix (курсорный SCAN + UNLINK, никогда
 * KEYS). Заслонка адресуется по userId — это внешний (вне PG) ресурс без
 * generation predicate, поэтому assertCurrent ДО и ПОСЛЕ (паттерн avatar/
 * guest-carry.stop). Токены верификации `ev-<token>`, magic-link `ml-*` и
 * SMS/security rate-limits НЕ трогаются: по аккаунту не адресуемы (ключ —
 * случайный токен) и относятся к безопасности — гаснут естественным TTL.
 *
 * legacy-auth.purge (после retention) удаляет строки легаси-таблицы
 * short_codes (001_core_schema.sql; эпоха n8n, TS-ссылок в репо нет — чистый
 * SQL) по phone=$1 под generation predicate. Ловушка схемы: phone varchar(20),
 * а userId email/OAuth-аккаунтов — UUID на 36 символов: сравнение varchar со
 * более длинным параметром в PG безопасно (матчит 0 строк, без ошибки),
 * колонка НЕ расширяется.
 *
 * retention_email_unsubscribes не выбирается никогда: suppression намеренно
 * переживает удаление аккаунта — письма на освобождённый адрес продолжать
 * ходить не должны (запинено в 17C, retention.stop).
 *
 * Job'ы пустые (payload {}, статический resourceKey 'legacy-auth' — урок
 * Task 11). Правила DELETION_DEPENDENCIES не нужно: stop (immediate) и purge
 * (после retention) не разделяют состояние — Redis-заслонка и строка
 * short_codes независимы. Повторный прогон идемпотентен (0 строк / пустой
 * SCAN — тихий успех).
 */

const SHORT_CODES_PURGE_SQL = `DELETE FROM short_codes
 WHERE phone=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

export async function discoverLegacyAuthDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: short_codes при
  // планировании не читается (коды в план не поднимаются).
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [
      {
        resourceType: 'auth-verification.stop',
        // Статический ключ (по одному job на аккаунт), без userId, по RESOURCE_KEY_RE.
        resourceKey: 'legacy-auth',
        phase: 'immediate',
        payload: {},
      },
      {
        resourceType: 'legacy-auth.purge',
        resourceKey: 'legacy-auth',
        phase: 'purge',
        payload: {},
      },
    ],
    skips: [],
  };
}

@Injectable()
export class LegacyAuthAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = [
    'auth-verification.stop',
    'legacy-auth.purge',
  ];

  constructor(
    private readonly redis: RedisService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'auth-verification.stop' && job.resourceType !== 'legacy-auth.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    if (job.resourceType === 'auth-verification.stop') {
      try {
        // Префикс собирается из job.userId (колонка job, не payload); форма
        // ключа — email.service.ts: `ev-sent-<userId>-<sha256(email)[:16]>`.
        await this.redis.deleteByPrefix(`ev-sent-${job.userId}-`);
      } catch (error) {
        if (error instanceof DeletionCancelledError) throw error;
        if (error instanceof DeletionRetryError) throw error;
        throw new DeletionRetryError(deletionErrorKind(error));
      }
      // Внешняя операция (Redis): поколение и lease перепроверяются после.
      await ctx.assertCurrent(job);
      return;
    }
    try {
      await ctx.db.query(SHORT_CODES_PURGE_SQL, [job.userId, job.deletionId]);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
