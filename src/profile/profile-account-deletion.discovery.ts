import { AccountDeletionPlanner } from '../account-deletion/account-deletion.planner';
import { DeletionCancelledError } from '../account-deletion/account-deletion.safe';
import type {
  DeletionAccount,
  DeletionJobRow,
  DeletionOrigin,
} from '../account-deletion/account-deletion.types';
import { inTransaction, TxSource } from '../blog/blog-slot-claim';
import { discoverChatFiles } from '../chat/chat-files/chat-file-account-deletion.adapter';
import type { ExtractEnv } from '../chat/chat-files/extract';

/**
 * Task 17 — повторный capture ссылок на файлы переписки перед core finalize.
 *
 * История чата стирается в той же execute, что и остальные core-строки, а
 * объекты MinIO удаляются отдельными chat-file.purge job'ами через 30 дней.
 * Между планированием (begin/merge) и фактическим finalize в историю могут
 * прийти новые файлы (ассистент дописал ответ, пользователь загрузил
 * документ) — recapture перечитывает историю удалённого ПОКОЛЕНИЯ тем же
 * исчерпывающим discoverChatFiles (keyset-пагинация без потолков) и дописывает
 * недостающие ссылки job'ами ДО удаления строк.
 *
 * Идемпотентность: persist идёт через planner.persist — INSERT ... ON CONFLICT
 * (deletion_id, resource_type, resource_key) DO NOTHING, поэтому повторный
 * прогон (retry после сбоя) не плодит дубликаты. Транзакция короткая и
 * отдельная от local finalize: jobs — аудит/план, их не откатывает racing
 * reactivation (поколение проверяется заново на каждом следующем шаге).
 *
 * Новые stop-задачи, созданные этим capture, блокируют core dependency
 * (DELETION_DEPENDENCIES allStop + assertNoImmediateBlockers): порядок
 * «сначала остановить, потом стирать» сохраняется и для поздних находок.
 */

type RecaptureDb = TxSource & {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
};

export class ProfileAccountDeletionRecapture {
  constructor(
    private readonly pg: RecaptureDb,
    private readonly planner: AccountDeletionPlanner,
    /** Окружение для discoverChatFiles; по умолчанию — extractEnv() из process.env. */
    private readonly env?: ExtractEnv,
  ) {}

  async collectAndPersist(job: DeletionJobRow): Promise<void> {
    // Поколение читаем fenced: если аккаунт реактивирован (или удалён заново
    // с другим deletion_id), никакого capture — core execute отменяется.
    const gen = await this.pg.query(
      `SELECT deleted_at FROM user_id
        WHERE internal_id = $1 AND state = 'deleted' AND deletion_id = $2`,
      [job.userId, job.deletionId],
    );
    const deletedAt = gen.rows?.[0]?.deleted_at;
    if (gen.rowCount !== 1 || !deletedAt) throw new DeletionCancelledError();

    const account: DeletionAccount = {
      userId: job.userId,
      deletionId: job.deletionId,
      deletedAt: new Date(deletedAt),
    };
    // Origin — как у planner.collect: immediate-вариант создаётся только
    // явным удалением. На состав файлов это не влияет (discoverChatFiles
    // origin не использует), но план обязан быть совместим с будущим
    // аудитором происхождения.
    const origin: DeletionOrigin =
      job.resourceType === 'account.core.immediate' ? 'explicit' : 'merge';

    const plan = await discoverChatFiles(
      this.env
        ? { db: this.pg, account, origin, env: this.env }
        : { db: this.pg, account, origin },
    );
    // Пустой план (файлов нет или все уже захвачены) — без транзакции.
    if (plan.jobs.length === 0) return;

    await inTransaction(this.pg, (tx) => this.planner.persist(tx, account, plan));
  }
}
