import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionJobs } from '../account-deletion/account-deletion.jobs';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionErrorKind,
} from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionExecution,
  DeletionJobRow,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { inTransaction, SlotQueryable } from '../blog/blog-slot-claim';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { ProfileAccountDeletionRecapture } from './profile-account-deletion.discovery';

/**
 * Task 17 — fenced finalize ядра аккаунта (account.core.immediate / account.core.purge).
 *
 * Порядок execute фиксирует план:
 *   1. assertCurrent            — поколение/лиз живы до первого шага;
 *   2. recapture                — поздние файлы переписки становятся
 *                                 chat-file.purge job'ами ДО стирания истории
 *                                 (отдельная короткая tx, ON CONFLICT DO NOTHING);
 *   3. assertNoImmediateBlockers — новые stop-задачи из recapture блокируют
 *                                 destructive-шаги (retryable, не cancelled);
 *   4. assertCurrent            — поколение могло смениться, пока шёл recapture;
 *   5. graph (strict)           — Neo4j идемпотентен и выполняется ДО local tx:
 *                                 сбой графа оставляет local-строки на месте,
 *                                 retry повторяет graph безопасно;
 *   6. assertCurrent            — reactivation между graph и local delete
 *                                 отменяет finalize;
 *   7. одна транзакция: lockAndAssertCurrent (FOR UPDATE + проверка поколения)
 *      и deleteOwnedCoreRows — атомарный local finalize.
 *
 * Immediate и purge идут одним кодом: состав core-строк от происхождения не
 * зависит, а идентичности, перенесённые merge-ом survivor-у, fenced-DELETE
 * по loser-ключу естественно не задевает.
 *
 * НЕ трогаем: payments, token_transactions, login_history (аудит/биллинг),
 * user_id кроме tombstone-полей (поколение принадлежит begin()/reactivation),
 * account_deletion_jobs (аудит плана), доменные таблицы других задач (17A–17E).
 * user_id.internal_id и surrogate-строка ai_profiles_consolidated остаются как
 * минимальный lifecycle/billing shell: на internal_id завязаны FK и аудит,
 * а contacts.purge (Task 17B) читает строку профиля после core.
 */

/**
 * Поколенческий предикат: любое destructive-выражение проходит, только пока
 * строка удалённого ПОКОЛЕНИЯ (state='deleted' AND deletion_id=…) на месте.
 * Если аккаунт реактивировали (или удалили заново), предикат даёт 0 строк —
 * выражение становится no-op даже в гонке, которую не поймали fence-проверки.
 */
const FENCED_BY_DELETED_GENERATION =
  `EXISTS (SELECT 1 FROM user_id WHERE internal_id = $1 AND state = 'deleted' AND deletion_id = $2)`;

/**
 * Стирание core-строк удалённого поколения. Только внутри транзакции
 * lockAndAssertCurrent; params каждого выражения — [userId, deletionId],
 * никаких литералов пользователя в SQL.
 *
 * Порядок: история, планы и точки «Чистого листа» → профиль/бизнес-данные →
 * связки входа → tombstone учётки.
 */
export async function deleteOwnedCoreRows(
  tx: SlotQueryable,
  job: DeletionJobRow,
): Promise<void> {
  const params = [job.userId, job.deletionId];

  // `_` в LIKE экранирован: иначе удаление номера 7903016918 стёрло бы и
  // переписку 79030169187 — `_` в шаблоне совпадает с любым символом.
  await tx.query(
    `DELETE FROM custom_chat_history
      WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\'
        AND ${FENCED_BY_DELETED_GENERATION}`,
    params,
  );
  await tx.query(
    `DELETE FROM action_plans
      WHERE user_id = $1
        AND ${FENCED_BY_DELETED_GENERATION}`,
    params,
  );
  // Точки «Чистого листа» (spec 2026-11-17-context-reset) — та же судьба,
  // что у истории: без неё точка смысла не имеет. Таблицу создаёт стартовая
  // миграция ContextResetModule (onModuleInit). В API удаление запускают
  // HTTP-вход и cron coordinator'а — оба оживают после onModuleInit, так что
  // таблица к ним уже есть. Synthetic-скрипт удаления
  // (scripts/account-deletion-synthetic.ts) таблицу не создаёт: запускать его
  // только после выката ветки на test; иначе core упадёт без потерь
  // (транзакция откатится).
  await tx.query(
    `DELETE FROM chat_context_resets
      WHERE user_id = $1
        AND ${FENCED_BY_DELETED_GENERATION}`,
    params,
  );
  // Строка ai_profiles_consolidated НЕ удаляется: surrogate id нужен как
  // lifecycle/billing shell (см. шапку). Чистится содержимое.
  await tx.query(
    `UPDATE ai_profiles_consolidated
      SET profile_data = '{}', email = NULL, preferred_agent = NULL,
          isadmin = false, tokens = 0, updated_at = now()
      WHERE user_id = $1
        AND ${FENCED_BY_DELETED_GENERATION}`,
    params,
  );

  // Связки входа рвём — иначе «удаление» им не является.
  //
  // Раньше строки user_identities оставались жить, чтобы перерегистрация
  // тем же телефоном или почтой возвращала прежний баланс. Побочный эффект
  // оказался таким: удалённый аккаунт пускал обратно по СТАРОМУ паролю, а
  // связывание отдельной строкой поднимало ему state обратно в active. То
  // есть с точки зрения человека аккаунт не удалялся вовсе — что и увидели
  // при съёмке для Apple. Правило 5.1.1(v) считает это деактивацией, а не
  // удалением.
  await tx.query(
    `DELETE FROM user_identities
      WHERE user_id = $1
        AND ${FENCED_BY_DELETED_GENERATION}`,
    params,
  );
  // Связка Telegram-бота — тоже связка входа: по ней мини-приложение узнаёт
  // «старожилов бота», выдаёт им токены и заново заводит строку в
  // user_identities. Пока она переживала удаление, Telegram удалённого
  // аккаунта входил в него обратно. Бот и биллинг ботов отсутствие строки
  // уже понимают — так выглядит любой, кто Telegram не привязывал: личка
  // предложит подключиться, у групповых конфигов просто некому писать о
  // балансе. Сама строка 1:1, так что освобождается и сам Telegram — его
  // можно привязать к другому аккаунту без упора в UNIQUE (tg_user_id).
  await tx.query(
    `DELETE FROM tg_user_identities
      WHERE linkeon_user_id = $1
        AND ${FENCED_BY_DELETED_GENERATION}`,
    params,
  );

  // Tombstone учётки. Пароль и почту гасим здесь: пароль иначе остался бы
  // годным для нового аккаунта с тем же адресом, а primary_email —
  // единственная оставшаяся копия адреса. state/deleted_at/deletion_id НЕ
  // трогаем: поколение ставит begin() и снимает reactivation, а не finalize.
  //
  // contacts (json) гасим тоже (T17-M6): writer'ов в дереве нет, но колонка
  // исторически могла быть наполнена, а план требует её очистки.
  // primary_phone НЕ трогаем — решение владельца (GAP A): телефонный
  // internal_id и так остаётся как lifecycle-ключ.
  //
  // welcome_bonus_at сохраняем намеренно (T20-M1): приветственный бонус
  // выдаётся один раз на аккаунт за всё время. У пользователя с телефонным
  // входом internal_id — это сам номер, перерегистрация реактивирует ту же
  // строку, и вернувшийся после удаления получает аккаунт без стартового
  // бонуса (issueWelcomeBonus не пройдёт claim). Прежний сброс отметки
  // давал бонус заново тому, кто возвращался до ближайшего рестарта API:
  // на старте 001_identity_init.sql заполняет пустую отметку create_date.
  //
  // welcome_bonus_at — ещё и «дата рождения» аккаунта: от неё считаются
  // окно рефералки (referral.service.ts — REFERRAL_NEW_ACCOUNT_WINDOW_MS и
  // проверка в регистрации реферала) и когорты мониторинга
  // (src/monitoring/product/{summary,economy,churn}.service.ts). Вернувшийся
  // пользователь там считается старым — это осознанное следствие.
  //
  // Известный остаток: выданный РАНЬШЕ access-токен продолжает пускать до
  // своего истечения — по умолчанию два часа (JWT_ACCESS_EXPIRES). Связок
  // входа уже нет и продлить его нельзя (см. AuthService.isDeleted), но
  // сам он ещё годен. Проверено на тестовом стенде 15.08.2026.
  //
  // Не закрыто сознательно: проверка состояния в JwtGuard легла бы на
  // КАЖДЫЙ авторизованный запрос, и ошибка в ней кладёт весь API — размен
  // хуже самой дыры. Дыра при этом ведёт к уже пустому аккаунту: профиль
  // очищен, история удалена, баланс обнулён. Клиент после удаления сам
  // выходит и токен выбрасывает.
  await tx.query(
    `UPDATE user_id
      SET password_hash = NULL, primary_email = NULL, contacts = NULL,
          update_date = now()
      WHERE internal_id = $1 AND state = 'deleted' AND deletion_id = $2`,
    params,
  );
}

@Injectable()
export class ProfileAccountDeletionAdapter
  implements OnModuleInit, AccountDeletionAdapter
{
  readonly resourceTypes: readonly DeletionResourceType[] = [
    'account.core.immediate',
    'account.core.purge',
  ];

  // pg инжектится классовым токеном PgService (интерфейс TxSource в
  // декорированном классе стёрся бы до Object и Nest не смог бы разрешить
  // зависимость); структурно PgService — TxSource для inTransaction.
  constructor(
    private readonly pg: PgService,
    private readonly jobs: AccountDeletionJobs,
    private readonly recapture: ProfileAccountDeletionRecapture,
    private readonly neo4j: Neo4jService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (
      job.resourceType !== 'account.core.immediate' &&
      job.resourceType !== 'account.core.purge'
    ) {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    // Повторный capture: поздние файлы переписки обязаны стать job'ами до
    // стирания истории. Отдельная короткая tx — план/аудит не откатывает
    // racing reactivation, поколение перепроверяется следующим шагом.
    await this.recapture.collectAndPersist(job);
    // Recapture мог создать новые stop-задачи; core от них зависит (allStop).
    // Исход retryable: поколение текущее, просто ждём завершения stop.
    await this.jobs.assertNoImmediateBlockers(job.deletionId);
    await ctx.assertCurrent(job);

    // Strict-вариант: legacy deleteUserGraph глотает ошибки (оставлен для
    // старых путей), pipeline обязан замечать сбой графа и повторять.
    try {
      await this.neo4j.deleteUserGraphStrict(job.userId);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
    await ctx.assertCurrent(job);

    await inTransaction(this.pg, async (tx) => {
      await this.jobs.lockAndAssertCurrent(tx, job);
      await deleteOwnedCoreRows(tx, job);
    });
  }
}
