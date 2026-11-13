import { Injectable, OnModuleInit } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DeletionRetryError, deletionErrorKind } from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscoverer,
  DeletionExecution,
  DeletionJobRow,
  DeletionJobSpec,
  DeletionResourceType,
  DeletionSkip,
} from '../account-deletion/account-deletion.types';
import { CalendarService } from './calendar.service';

/**
 * Task 9 — календарь при удалении аккаунта.
 *
 * Discovery только читает. Главное ограничение: внешнее событие (UID в
 * предложении) нельзя удалить, если мы не можем ДОКАЗАТЬ, что оно личное и
 * создано Линкеоном — UID может принадлежать общему календарю, и внешний
 * DELETE стёр бы чужую встречу. Поэтому предложение с uid, но без durable
 * ownership evidence, даёт фиксированный skip calendar.external /
 * owner_unverifiable (тип skip-only: sanitizer не пустит его в jobs).
 * Evidence — явный маркер createdByLinkeon в JSONB события; сегодня его никто
 * не пишет, так что на текущих данных skip получают все внешние uid.
 *
 * Личные строки (calendar_proposals, trip_calendars, calendar_connections,
 * linkeon_tasks, day_framing) чистит purge-задача с generation predicate:
 * старый deletionId после reactivation не удаляет ничего. Секреты соединений
 * (secret_enc) стираются вместе со строкой подключения — но только после
 * успешной остановки (зависимость calendar.purge: allOf calendar.stop в
 * каталоге); сам stop — soft-disable (enabled=false), а не hard-delete.
 */

/** Единственный признак «событие создано Линкеоном и принадлежит владельцу». */
function hasDurableOwnershipEvidence(event: unknown): boolean {
  return (
    typeof event === 'object'
    && event !== null
    && (event as Record<string, unknown>).createdByLinkeon === true
  );
}

export const discoverCalendarDeletion: DeletionDiscoverer = async ({ db, account }) => {
  const connections = await db.query(
    `SELECT c.provider FROM calendar_connections c WHERE c.user_id=$1 ORDER BY c.provider`,
    [account.userId],
  );
  const proposals = await db.query(
    `SELECT p.id,p.event FROM calendar_proposals p WHERE p.user_id=$1 ORDER BY p.id`,
    [account.userId],
  );
  const ics = await db.query(
    `SELECT 1 FROM trip_calendars t WHERE t.user_id=$1 LIMIT 1`,
    [account.userId],
  );

  const jobs: DeletionJobSpec[] = [];
  const skips: DeletionSkip[] = [];
  // Review I-1 (защитный слой): CalendarController.connect исторически пропускал
  // body.provider без валидации, поэтому в calendar_connections может лежать
  // отравленная строка ('Yandex 360', 'yandex ', 200 символов). Она ломает
  // sanitizer (RESOURCE_KEY_RE/unsafePayloadString), а ошибка одного discoverer'а
  // роняет ВЕСЬ план удаления. Clamp в фиксированный enum, который execute
  // реально использует для маршрутизации, + дедуп: PK (user_id, provider)
  // допускает одновременные 'yandex' и 'yandex ', а stop после clamp один.
  const stopProviders = new Set<'yandex' | 'exchange'>();
  for (const row of connections.rows) {
    stopProviders.add(row.provider === 'exchange' ? 'exchange' : 'yandex');
  }
  for (const provider of stopProviders) {
    jobs.push({
      resourceType: 'calendar.stop',
      resourceKey: provider,
      phase: 'immediate',
      payload: { provider },
    });
  }
  let unverifiableExternal = false;
  for (const row of proposals.rows) {
    const event = row.event ?? null;
    const uid = typeof event?.uid === 'string' ? event.uid : '';
    if (!uid) continue; // внешне удалять нечего — локальную строку сотрёт purge
    if (!hasDurableOwnershipEvidence(event)) unverifiableExternal = true;
    // С evidence внешний DELETE всё равно не часть deletion-pipeline:
    // calendar.external — skip-only тип, события живут во внешнем календаре
    // владельца и остаются у него.
  }
  // Review I-9: один skip на discovery, а не по одному на каждое событие —
  // N одинаковых skip'ов раздувают план, не добавляя информации.
  if (unverifiableExternal) {
    skips.push({ resourceType: 'calendar.external', reason: 'owner_unverifiable' });
  }
  if (connections.rows.length > 0 || proposals.rows.length > 0 || ics.rows.length > 0) {
    jobs.push({
      resourceType: 'calendar.purge',
      resourceKey: 'calendar',
      phase: 'purge',
      payload: {},
    });
  }
  return { jobs, skips };
};

@Injectable()
export class CalendarAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['calendar.stop', 'calendar.purge'];

  constructor(
    private readonly pg: PgService,
    private readonly calendar: CalendarService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    switch (job.resourceType) {
      case 'calendar.stop': {
        await ctx.assertCurrent(job);
        const provider = typeof job.payload?.provider === 'string'
          ? job.payload.provider
          : job.resourceKey;
        try {
          // Существующие disconnect/disconnectExchange идемпотентны: отсутствие
          // строки подключения — не ошибка. Внешние вызовы (revoke у провайдера)
          // они не делают и строку не удаляют: это soft-disable — enabled=false
          // с сохранением secret_enc (правило reconnect: переподключение чинит
          // доступ без повторного ввода пароля). Строка вместе с секретами
          // стирает задача calendar.purge — после успешной остановки (allOf).
          if (provider === 'exchange') await this.calendar.disconnectExchange(job.userId);
          else await this.calendar.disconnect(job.userId);
        } catch (error) {
          // Ошибка провайдера/БД — fail-closed retry с техническим kind;
          // текст ошибки (может содержать URL/детали) наружу не уходит.
          throw new DeletionRetryError(deletionErrorKind(error));
        }
        return;
      }
      case 'calendar.purge': {
        await ctx.assertCurrent(job);
        // Generation predicate: удаляем только строки владельца текущего
        // поколения удаления; после reactivation старый deletionId не совпадёт.
        for (const sql of [
          `DELETE FROM calendar_proposals p
            WHERE p.user_id=$1
              AND EXISTS (
                SELECT 1 FROM user_id u
                WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2
              )`,
          `DELETE FROM trip_calendars t
            WHERE t.user_id=$1
              AND EXISTS (
                SELECT 1 FROM user_id u
                WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2
              )`,
          `DELETE FROM calendar_connections c
            WHERE c.user_id=$1
              AND EXISTS (
                SELECT 1 FROM user_id u
                WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2
              )`,
          // Review I-4: linkeon_tasks («дом дел») и day_framing (фреймы дня) —
          // тоже calendar/trip-домен (LinkeonTasksService и DayFramingStore —
          // провайдеры CalendarModule), таблицы без FK, и до этой правки их не
          // стирал никто: план чистил tasks (TasksService), но не linkeon_tasks.
          `DELETE FROM linkeon_tasks l
            WHERE l.user_id=$1
              AND EXISTS (
                SELECT 1 FROM user_id u
                WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2
              )`,
          `DELETE FROM day_framing d
            WHERE d.user_id=$1
              AND EXISTS (
                SELECT 1 FROM user_id u
                WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2
              )`,
        ]) {
          await this.pg.query(sql, [job.userId, job.deletionId]);
        }
        return;
      }
      default:
        throw new Error('unsupported_deletion_resource');
    }
  }
}
