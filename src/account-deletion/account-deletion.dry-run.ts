import { DELETION_DISCOVERERS } from './account-deletion.catalog';
import { AccountDeletionPlanner } from './account-deletion.planner';
import { ACCOUNT_DELETION_RETENTION_MS } from './account-deletion.safe';
import type {
  DeletionAccount,
  DeletionDiscovery,
  DeletionOrigin,
} from './account-deletion.types';

type Db = DeletionDiscovery['db'];

/**
 * Task 21 — строгий dry-run очистки аккаунтов.
 *
 * Прогноз плана удаления для ВСЕХ кандидатов, дошедших до срока
 * (deletedAt + retention), БЕЗ побочных эффектов: используется только
 * AccountDeletionPlanner.collect с полным каталогом DELETION_DISCOVERERS.
 * Персистенция плана (persist), реестр/адаптеры (getExecutor), внешние
 * клиенты (MinIO/Telegram/products-host), миграции и schema service не
 * задействованы; весь SQL — SELECT. Сводка — только счётчики: ни списков
 * userId/deletionId, ни файлов отчёта.
 */

/** Сводка dry-run: счётчики, без идентификаторов аккаунтов. */
export interface DryRunSummary {
  accounts: number;
  jobsByType: Record<string, number>;
  skipsByReason: Record<string, number>;
}

/**
 * Любой --apply отклоняется: у инструмента НЕТ режима исполнения. Ошибка
 * бросается до создания подключения к БД (CLI выходит с кодом 2).
 */
export class DryRunApplyError extends Error {
  constructor() {
    super('dry-run only: account-deletion-dry-run never applies deletions');
    this.name = 'DryRunApplyError';
  }
}

/**
 * Разбор аргументов CLI — экспортируется отдельно, чтобы контракт «--apply
 * → отказ» тестировался без spawn и без БД. Значения аргументов в сообщения
 * об ошибках не подставляются (в консоли не должно появляться ничего, кроме
 * безопасного текста).
 */
export function parseDryRunArgs(argv: readonly string[]): { retentionMs: number } {
  let retentionMs = ACCOUNT_DELETION_RETENTION_MS;
  for (const arg of argv) {
    if (arg === '--apply') throw new DryRunApplyError();
    if (arg.startsWith('--retention-ms=')) {
      const raw = arg.slice('--retention-ms='.length);
      if (!/^\d+$/.test(raw)) {
        throw new Error('--retention-ms: требуется неотрицательное целое число миллисекунд');
      }
      retentionMs = Number(raw);
      continue;
    }
    throw new Error('неизвестный аргумент (допустим только --retention-ms=N; режима исполнения нет)');
  }
  return { retentionMs };
}

/**
 * Read-only аналог AccountDeletionJobs.dueAccounts без keyset-курсора:
 * прогнозу нужен ВЕСЬ список кандидатов, дошедших до срока, одной выборкой
 * (без батчей, FOR UPDATE и SKIP LOCKED — сухому прогону нечего делить
 * с воркером).
 */
export async function selectDeletionCandidates(
  db: Db,
  retentionMs: number,
): Promise<DeletionAccount[]> {
  const result = await db.query(
    `SELECT internal_id,deletion_id,deleted_at
     FROM user_id
     WHERE state='deleted'
       AND deletion_id IS NOT NULL
       AND deleted_at IS NOT NULL
       AND deleted_at<=now()-($1::bigint * interval '1 millisecond')
     ORDER BY deleted_at,internal_id`,
    [retentionMs],
  );
  return result.rows.map((row) => ({
    userId: row.internal_id,
    deletionId: row.deletion_id,
    deletedAt: row.deleted_at,
  }));
}

/**
 * Origin по СУЩЕСТВУЮЩЕЙ core-задаче — зеркало AccountDeletionJobs.originOf,
 * ничего не создаёт. Ветка «core-строк нет вовсе» (план ни разу не
 * персистился — например, поколение старше координатора Task 17): 'merge',
 * как у originOf — отсутствие account.core.immediate означает merge-происхождение
 * либо его утрату, и координатор спланировал бы такой аккаунт точно так же
 * (отложенный core.purge). Прогноз dry-run совпадает с поведением воркера.
 */
export async function readExistingOrigin(
  db: Db,
  account: DeletionAccount,
): Promise<DeletionOrigin> {
  const result = await db.query(
    `SELECT 1
     FROM account_deletion_jobs
     WHERE deletion_id=$1
       AND user_id=$2
       AND resource_type='account.core.immediate'
     LIMIT 1`,
    [account.deletionId, account.userId],
  );
  return result.rowCount === 1 ? 'explicit' : 'merge';
}

/**
 * Собрать прогноз: для каждого кандидата — collect() полного каталога
 * (core-задача добавляется коллектором ВСЕГДА, поэтому в jobsByType она
 * присутствует) и счётчики jobs/skips. Ничего не пишется ни в БД, ни на диск.
 */
export async function dryRunAccountDeletion(
  db: Db,
  options: { retentionMs: number },
): Promise<DryRunSummary> {
  const accounts = await selectDeletionCandidates(db, options.retentionMs);
  const summary: DryRunSummary = {
    accounts: accounts.length,
    jobsByType: {},
    skipsByReason: {},
  };
  for (const account of accounts) {
    const origin = await readExistingOrigin(db, account);
    const plan = await new AccountDeletionPlanner(DELETION_DISCOVERERS)
      .collect(db, account, origin);
    for (const job of plan.jobs) {
      summary.jobsByType[job.resourceType] =
        (summary.jobsByType[job.resourceType] ?? 0) + 1;
    }
    for (const skip of plan.skips) {
      summary.skipsByReason[skip.reason] =
        (summary.skipsByReason[skip.reason] ?? 0) + 1;
    }
  }
  return summary;
}
