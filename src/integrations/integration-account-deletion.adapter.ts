import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DeletionRetryError, deletionErrorKind } from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscoverer,
  DeletionExecution,
  DeletionJobRow,
  DeletionJobSpec,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { OAuthAppleService } from '../auth/oauth-apple.service';
import { IdentityService } from '../identity/identity.service';
import { TalerIdOauthService } from '../talerid/talerid-oauth.service';
import { ZoomOauthService } from '../zoom/zoom-oauth.service';

/**
 * Task 9 — OAuth/интеграции при удалении аккаунта.
 *
 * Три account-level stop-задачи (по одной на провайдера, только если связка
 * существует). Apple: Sign in with Apple ТРЕБУЕТ отозвать доступ приложения
 * до удаления аккаунта — refresh-токены читаются из user_identities только в
 * памяти execute и не попадают ни в job payload, ни в журналы, ни в SQL
 * discovery. Отзыв должен пройти ДО identity unlink: порядок обеспечивает
 * зависимость account.core.purge {allStop:true} — unlink делает только
 * account.core после завершения всех стоп-задач поколения.
 *
 * Zoom/TalerID: существующий disconnect — идемпотентный hard-delete строки
 * подключения с токенами. Неизвестный результат внешнего вызова → fail-closed
 * retry (DeletionRetryError с техническим kind).
 *
 * integration_flags (глобальные выключатели) и singleton
 * short_youtube_account не выбираются и не изменяются: это ресурсы
 * платформы, а не пользователя.
 */
export const discoverIntegrationDeletion: DeletionDiscoverer = async ({ db, account }) => {
  const apple = await db.query(
    `SELECT 1 FROM user_identities i WHERE i.user_id=$1
      AND i.provider='apple' AND i.provider_refresh_token IS NOT NULL LIMIT 1`,
    [account.userId],
  );
  const zoom = await db.query(
    `SELECT 1 FROM zoom_connections z WHERE z.user_id=$1 LIMIT 1`,
    [account.userId],
  );
  const talerid = await db.query(
    `SELECT 1 FROM talerid_connections t WHERE t.user_id=$1 LIMIT 1`,
    [account.userId],
  );

  const jobs: DeletionJobSpec[] = [];
  const known: Array<[DeletionResourceType, string, boolean]> = [
    ['integration.apple.stop', 'apple', apple.rows.length > 0],
    ['integration.zoom.stop', 'zoom', zoom.rows.length > 0],
    ['integration.talerid.stop', 'talerid', talerid.rows.length > 0],
  ];
  for (const [resourceType, resourceKey, exists] of known) {
    if (!exists) continue;
    // Payload пустой: ни токены, ни идентификаторы пользователя в persistent
    // job не попадают — всё, что нужно execute, это userId/deletionId строки.
    jobs.push({ resourceType, resourceKey, phase: 'immediate', payload: {} });
  }
  return { jobs, skips: [] };
};

@Injectable()
export class IntegrationAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = [
    'integration.apple.stop',
    'integration.zoom.stop',
    'integration.talerid.stop',
  ];

  constructor(
    private readonly identity: IdentityService,
    private readonly apple: OAuthAppleService,
    private readonly zoom: ZoomOauthService,
    private readonly talerid: TalerIdOauthService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    switch (job.resourceType) {
      case 'integration.apple.stop': {
        await ctx.assertCurrent(job);
        // Токены живут только в памяти этого вызова.
        const tokens = await this.identity.providerRefreshTokens(job.userId, 'apple');
        if (tokens.length === 0) return; // unlink уже произошёл — идемпотентный успех
        const clientId = this.apple.primaryClientId();
        for (const token of tokens) {
          let revoked: boolean;
          try {
            revoked = await this.apple.revokeToken(token, clientId);
          } catch (error) {
            // revokeToken в проде глотает ошибки и возвращает false; catch —
            // защита от неожиданного проброса (kind остаётся retry-совместимым).
            throw new DeletionRetryError(deletionErrorKind(error));
          }
          // Неизвестный результат (Apple не подтвердил отзыв) — fail-closed retry.
          if (!revoked) throw new DeletionRetryError('external_unknown');
        }
        return;
      }
      case 'integration.zoom.stop': {
        await ctx.assertCurrent(job);
        try {
          await this.zoom.disconnect(job.userId);
        } catch (error) {
          throw new DeletionRetryError(deletionErrorKind(error));
        }
        return;
      }
      case 'integration.talerid.stop': {
        await ctx.assertCurrent(job);
        try {
          await this.talerid.disconnect(job.userId);
        } catch (error) {
          throw new DeletionRetryError(deletionErrorKind(error));
        }
        return;
      }
      default:
        throw new Error('unsupported_deletion_resource');
    }
  }
}
