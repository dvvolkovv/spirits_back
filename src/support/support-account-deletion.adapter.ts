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
 * Task 17A — support: немедленная остановка и delayed purge.
 *
 * support.stop (immediate) переводит незавершённые tickets поколения
 * ('ai_handling','escalated','owner_handling' — незакрытые статусы из
 * 001_support.sql и support.service.ts:84) в 'closed'. 'resolved' остаётся:
 * это уже терминальный статус с выставленным resolved_at.
 *
 * support.purge (после retention), строго по порядку:
 *  1. SELECT id своих tickets под generation predicate;
 *  2. DELETE FROM alert_bot_ticket_drafts по ticket IDs — ЯВНО и ДО тикетов:
 *     у drafts.ticket_id нет FK на support_tickets (001_alert_bot.sql:22-24),
 *     cascade их не удалит, а после удаления тикетов их уже не выбрать.
 *     Свой generation predicate защищает от реактивации между шагами;
 *  3. DELETE FROM support_tickets WHERE id = ANY(...) AND user_id — scope по
 *     id+user_id; support_messages/support_events исчезают существующим FK
 *     ON DELETE CASCADE (001_support.sql:33,48).
 *
 * service_health (общий снапшот здоровья сервисов, PK — имя сервиса) и
 * alert_bot_turns (операционный журнал alert-бота; владелец строк — оператор
 * поддержки, не удаляемый пользователь) в SQL удаления НЕ упоминаются и
 * сохраняются.
 *
 * Job'ы пустые (payload {}, статические resourceKey 'support' — урок Task 11).
 * Внешних вызовов (LLM/Telegram) нет — только SQL: один assertCurrent до
 * записи, TOCTOU закрывают generation predicate'ы, повторный прогон
 * идемпотентен (0 строк — тихий успех, паттерн events). Порядок stop → purge
 * обеспечивает DELETION_DEPENDENCIES ('support.purge': { allOf: ['support.stop'] })
 * через DEPENDENCY_ELIGIBILITY_SQL в claimNext: stop failure оставляет ticket
 * для retry и не пускает purge.
 *
 * Отклонение от Files-списка плана: alert-bot.store.ts не изменяется —
 * owner-scoped удаление drafts живёт здесь как SQL по ticket IDs конкретного
 * владельца через ctx.db (с generation predicate, которого у store-методов
 * нет; store-метод без вызова был бы мёртвым кодом). Черновики при этом
 * удаляются независимо от того, какой оператор (linkeon_user_id) их создал:
 * принадлежность определяется тикетом удаляемого пользователя.
 */

const SUPPORT_STOP_SQL = `UPDATE support_tickets SET status='closed', updated_at=now()
 WHERE user_id=$1 AND status IN ('ai_handling','escalated','owner_handling')
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

const SUPPORT_TICKET_IDS_SQL = `SELECT id FROM support_tickets
 WHERE user_id=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

const SUPPORT_DRAFTS_PURGE_SQL = `DELETE FROM alert_bot_ticket_drafts
 WHERE ticket_id = ANY($1::uuid[])
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$2 AND u.state='deleted' AND u.deletion_id=$3)`;

const SUPPORT_TICKETS_PURGE_SQL = `DELETE FROM support_tickets
 WHERE id = ANY($1::uuid[]) AND user_id=$2
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$2 AND u.state='deleted' AND u.deletion_id=$3)`;

export async function discoverSupportDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: тикеты и черновики при
  // планировании не читаются (topic/notes/тексты в план не поднимаются).
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [
      {
        resourceType: 'support.stop',
        // Статический ключ (по одному job на аккаунт), без userId, по RESOURCE_KEY_RE.
        resourceKey: 'support',
        phase: 'immediate',
        payload: {},
      },
      {
        resourceType: 'support.purge',
        resourceKey: 'support',
        phase: 'purge',
        payload: {},
      },
    ],
    skips: [],
  };
}

@Injectable()
export class SupportAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['support.stop', 'support.purge'];

  constructor(private readonly registry: AccountDeletionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'support.stop' && job.resourceType !== 'support.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    try {
      if (job.resourceType === 'support.stop') {
        await ctx.db.query(SUPPORT_STOP_SQL, [job.userId, job.deletionId]);
        return;
      }
      const ids = await ctx.db.query(SUPPORT_TICKET_IDS_SQL, [job.userId, job.deletionId]);
      const ticketIds = ids.rows.map((row: { id: string }) => String(row.id));
      // Нет тикетов поколения — нечего удалять, идемпотентный тихий успех.
      if (ticketIds.length === 0) return;
      // Drafts строго до tickets: FK на ticket_id нет, после удаления тикетов
      // черновики стали бы неудаляемыми сиротами.
      await ctx.db.query(SUPPORT_DRAFTS_PURGE_SQL, [ticketIds, job.userId, job.deletionId]);
      await ctx.db.query(SUPPORT_TICKETS_PURGE_SQL, [ticketIds, job.userId, job.deletionId]);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
