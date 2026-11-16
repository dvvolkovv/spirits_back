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
 * Task 17C — referral: выплаты останавливаются, ledger сохраняется.
 *
 * referral.stop (immediate) деактивирует лидера удалённого аккаунта
 * (referral_leaders.is_active=false). Strict-гейты в ReferralService
 * (requestWithdrawal/payoutTokens/notifyPayoutIfReady/register) после stop
 * не дают ни оформить новый вывод, ни начислить токены, ни пригласить нового
 * реферала по ссылке удалённого. Чужие лидеры не затрагиваются.
 *
 * referral.purge (после retention) — обезличивание связей БЕЗ удаления
 * финансовой истории:
 *  0. если висит ХОТЬ ОДИН pending-вывод удалённого (по user_phone ИЛИ по
 *     leader_id — колонка user_phone могла устареть) — DeletionRetryError
 *     ('external_unknown'): незакрытое денежное обязательство сначала должен
 *     обработать админ (processWithdrawal), данные не трогаются вовсе;
 *  1. requisites закрытых выводов (settled = 'paid' И 'rejected' — реквизиты
 *     отклонённой заявки это те же персональные платёжные данные) стираются
 *     ДО алиасинга: после замены user_phone условие =$1 свои строки не матчит;
 *  2. alias одного телефона в пяти колонках (leaders.user_phone,
 *     referees.referee_phone, commissions.referee_phone,
 *     token_payouts.user_phone, withdrawals.user_phone) — deletion-scoped
 *     'deleted:<deletionId>'; у своего лидера дополнительно name='' и
 *     slug='deleted-<deletionId>' (проходит CHECK '^[a-z0-9-]+$', уникален на
 *     deletionId — повторная регистрация того же номера не упирается в старый
 *     UNIQUE referee_phone: слот освобождается алиасингом);
 *  3. payment_id, commission_ids, суммы, paid_out, token_transactions и весь
 *     остальной ledger НЕ меняются — финансовая история переживает удаление.
 *
 * Каждое мутирующее statement несёт generation predicate (TOCTOU без
 * транзакций, паттерн peer/tasks/support): при реактивации или чужом
 * поколении UPDATE матчит 0 строк. Повторный purge идемпотентен: после
 * первого прогона условия user_phone=$1/referee_phone=$1 свои строки уже не
 * видят. Внешних вызовов нет — один assertCurrent до записей.
 *
 * Порядок stop → purge обеспечивает DELETION_DEPENDENCIES
 * ('referral.purge': { allOf: ['referral.stop'] }): stop блокирует
 * requestWithdrawal, закрывая окно между pending-проверкой и алиасингом —
 * новая pending-заявка в этот промежуток появиться не может.
 *
 * Ширина phone-колонок: deletionAlias — 44 символа. Колонки leaders/referees/
 * commissions уже TEXT (migrations/001_user_id_to_text.sql); инлайновые
 * token_payouts/withdrawals расширены до varchar(64) в onModuleInit
 * ReferralService (guarded DO-блок).
 */

const REFERRAL_STOP_SQL = `UPDATE referral_leaders SET is_active=false
 WHERE user_phone=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

// pending-вывод ищется и по user_phone, и по leader_id: user_phone в строке
// вывода мог устареть (копия на момент оформления), leader_id — надёжная связь.
const REFERRAL_PENDING_WITHDRAWAL_SQL = `SELECT 1 FROM referral_withdrawals w
 WHERE w.status='pending'
   AND (w.user_phone=$1
        OR w.leader_id IN (SELECT id FROM referral_leaders WHERE user_phone=$1))
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)
 LIMIT 1`;

const REFERRAL_WITHDRAWAL_REQUISITES_SQL = `UPDATE referral_withdrawals SET requisites=''
 WHERE user_phone=$1 AND status IN ('paid','rejected')
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

const REFERRAL_LEADER_ALIAS_SQL = `UPDATE referral_leaders
   SET user_phone=$2, name='', slug=$3, is_active=false
 WHERE user_phone=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$4)`;

const REFERRAL_REFEREE_ALIAS_SQL = `UPDATE referral_referees SET referee_phone=$2
 WHERE referee_phone=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$3)`;

const REFERRAL_COMMISSION_ALIAS_SQL = `UPDATE referral_commissions SET referee_phone=$2
 WHERE referee_phone=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$3)`;

const REFERRAL_PAYOUT_ALIAS_SQL = `UPDATE referral_token_payouts SET user_phone=$2
 WHERE user_phone=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$3)`;

const REFERRAL_WITHDRAWAL_ALIAS_SQL = `UPDATE referral_withdrawals SET user_phone=$2
 WHERE user_phone=$1
   AND EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$3)`;

export async function discoverReferralDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  // Единственный SQL discovery — generation gate: referral-таблицы при
  // планировании не читаются (реквизиты/телефоны в план не поднимаются).
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [
      {
        resourceType: 'referral.stop',
        // Статический ключ (по одному job на аккаунт), без userId, по RESOURCE_KEY_RE.
        resourceKey: 'referral',
        phase: 'immediate',
        payload: {},
      },
      {
        resourceType: 'referral.purge',
        resourceKey: 'referral',
        phase: 'purge',
        payload: {},
      },
    ],
    skips: [],
  };
}

@Injectable()
export class ReferralAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['referral.stop', 'referral.purge'];

  constructor(private readonly registry: AccountDeletionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'referral.stop' && job.resourceType !== 'referral.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    try {
      if (job.resourceType === 'referral.stop') {
        await ctx.db.query(REFERRAL_STOP_SQL, [job.userId, job.deletionId]);
        return;
      }

      // Незакрытое денежное обязательство блокирует purge: сначала админ
      // обрабатывает pending-вывод (processWithdrawal), затем retry.
      const pending = await ctx.db.query(REFERRAL_PENDING_WITHDRAWAL_SQL, [
        job.userId,
        job.deletionId,
      ]);
      if ((pending.rowCount ?? 0) > 0) {
        throw new DeletionRetryError('external_unknown');
      }

      // Deletion-scoped alias: только копии телефона в referral-журналах,
      // user_id.internal_id не переименовывается.
      const deletionAlias = `deleted:${job.deletionId}`;
      const deletedSlug = `deleted-${job.deletionId}`;
      // Порядок значим: requisites чистятся, пока user_phone=$1 ещё матчит
      // свои строки (после alias-UPDATE условие потеряется).
      await ctx.db.query(REFERRAL_WITHDRAWAL_REQUISITES_SQL, [job.userId, job.deletionId]);
      await ctx.db.query(REFERRAL_LEADER_ALIAS_SQL, [
        job.userId,
        deletionAlias,
        deletedSlug,
        job.deletionId,
      ]);
      await ctx.db.query(REFERRAL_REFEREE_ALIAS_SQL, [job.userId, deletionAlias, job.deletionId]);
      await ctx.db.query(REFERRAL_COMMISSION_ALIAS_SQL, [job.userId, deletionAlias, job.deletionId]);
      await ctx.db.query(REFERRAL_PAYOUT_ALIAS_SQL, [job.userId, deletionAlias, job.deletionId]);
      await ctx.db.query(REFERRAL_WITHDRAWAL_ALIAS_SQL, [job.userId, deletionAlias, job.deletionId]);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
