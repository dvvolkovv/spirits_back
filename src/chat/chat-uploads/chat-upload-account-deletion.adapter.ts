import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionErrorKind,
} from '../../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscovery,
  DeletionExecution,
  DeletionJobRow,
  DeletionPlan,
  DeletionResourceType,
} from '../../account-deletion/account-deletion.types';
// Value-импорт, НЕ `import type`: тип стирает design:paramtypes до
// Function/Object, и Nest не может разрешить конструктор провайдера
// (пин — chat-uploads.di.spec.ts).
import { StorageService } from '../../common/services/storage.service';
import { CHAT_UPLOADS_BUCKET } from './chat-uploads.service';
import { uploadThumbKey } from './upload-thumb';

/**
 * Phase 2 — исходники загрузок чата (chat_uploads) при удалении аккаунта.
 *
 * KB-обещание «Ваши загрузки удаляются вместе с аккаунтом» (platform-kb
 * account.ts) исполняется ЧЕРЕЗ КОНВЕЙЕР, а не inline-вызовом из
 * deleteProfile: inline миновал бы fencing — реактивация и merge-пути
 * пропускали бы очистку. Фаза purge: загрузки переживают 30-дневное окно
 * реактивации, как chat-file.purge (срок назначает planner:
 * deletedAt + ACCOUNT_DELETION_RETENTION_MS; правил DELETION_DEPENDENCIES
 * не нужно — stop-фазы и общего состояния с другими задачами нет).
 *
 * В отличие от chat-file.purge, ключи НЕ снапшотятся в payload: таблицу
 * chat_uploads никто кроме этого адаптера не стирает (старый inline-путь
 * ChatUploadsService.deleteForUser удалён — он миновал бы fencing), строки
 * доживают до purge — storage_key'и читаются из таблицы в момент исполнения.
 * Гонку реактивации в окне между последним assertCurrent и финальным DELETE
 * закрывает generation predicate внутри DELETE (state='deleted' +
 * deletion_id; дом-паттерн — devices-account-deletion.adapter.ts).
 * Одна задача на аккаунт, resourceKey статический ('chat-uploads', форма
 * tasks/support/peer/referral): userId в resourceKey забраковал бы
 * fail-closed sanitizer (safeDeletionJobSnapshot: resourceKey === userId).
 *
 * Fail-closed: storage_key и thumb_key (webp-миниатюра из миграции 002, тот же
 * бакет; NULL — миниатюры нет) — единственные указатели на байты, поэтому
 * строки удаляются ТОЛЬКО после подтверждённого удаления всех объектов
 * (deleteConfirmed: 'deleted' и 'absent' — успех; любой неизвестный исход —
 * DeletionRetryError с классификацией deletionErrorKind, строки сохраняются
 * для retry). Миниатюра стирается и по вычисляемому thumbs/<storage_key>.webp:
 * она могла лечь в бакет и при thumb_key = NULL (см. execute). Аномальный
 * ключ (пустой сегмент/'.'/'..') — retry kind db, слепого удаления нет.
 * Повторный прогон после частичного сбоя идемпотентен.
 *
 * Логирование — только safe-формы раннера (safeDeletionMessage): адаптер не
 * печатает storage_key/original_name/sha256/userId.
 */

/** Статический resourceKey единственной задачи на аккаунт. */
export const CHAT_UPLOAD_RESOURCE_KEY = 'chat-uploads';

function isSafeKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  return !key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/**
 * Discovery: у пользователя есть строки chat_uploads — одна purge-задача;
 * нет — плана нет. Ключи не читаются: снапшот не нужен (см. шапку файла).
 */
export async function discoverChatUploads(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const res = await ctx.db.query(
    'SELECT 1 FROM chat_uploads WHERE user_id = $1 LIMIT 1',
    [ctx.account.userId],
  );
  if ((res.rows?.length ?? 0) === 0) return { jobs: [], skips: [] };
  return {
    jobs: [{
      resourceType: 'chat-upload.purge',
      resourceKey: CHAT_UPLOAD_RESOURCE_KEY,
      phase: 'purge',
      payload: {},
    }],
    skips: [],
  };
}

@Injectable()
export class ChatUploadAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['chat-upload.purge'];

  constructor(
    private readonly storage: StorageService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'chat-upload.purge') {
      throw new Error('unsupported_deletion_resource');
    }

    await ctx.assertCurrent(job);
    const res = await ctx.db.query(
      'SELECT storage_key, thumb_key FROM chat_uploads WHERE user_id = $1',
      [job.userId],
    );
    for (const row of res.rows ?? []) {
      const key = typeof row?.storage_key === 'string' ? row.storage_key : '';
      // Миниатюра (миграция 002): NULL — её нет в реестре; любое другое
      // значение обязано быть таким же безопасным ключом, как storage_key.
      // Не-строка нормализуется как у storage_key — в '' (retry db): String()
      // сделал бы из 42 или массива «безопасный» ключ.
      const thumbKey = row?.thumb_key == null
        ? null
        : typeof row.thumb_key === 'string' ? row.thumb_key : '';
      // Миниатюра стирается и по thumb_key, и по вычисляемому
      // thumbs/<storage_key>.webp: неоднозначно оборвавшаяся загрузка
      // миниатюры при сохранении могла оставить объект при thumb_key = NULL
      // (так же — ChatUploadsService.deleteForOwner). Отсеивается только NULL,
      // а не всё ложное: пустой thumb_key — аномалия, а не «миниатюры нет».
      const objectKeys = [
        ...new Set([key, thumbKey, uploadThumbKey(key)].filter((k): k is string => k !== null)),
      ];
      // Ключи могли прийти только из нашей таблицы, но purge исполняется через
      // 30 дней: traversal/пустые сегменты отклоняются fail-closed — ДО
      // удаления любого объекта этой строки. Вычисляемый ключ из безопасного
      // storage_key безопасен, но проверяется тоже.
      if (!objectKeys.every((k) => isSafeKey(k))) throw new DeletionRetryError('db');
      for (const objectKey of objectKeys) {
        await ctx.assertCurrent(job);
        try {
          await this.storage.deleteConfirmed({ bucket: CHAT_UPLOADS_BUCKET, key: objectKey });
        } catch (error) {
          if (error instanceof DeletionCancelledError) throw error;
          throw new DeletionRetryError(deletionErrorKind(error));
        }
      }
    }

    // Строки — после объектов: при любом сбое выше указатели на байты живы.
    // TOCTOU между assertCurrent и DELETE закрывает generation predicate
    // внутри DELETE (дом-паттерн — devices-account-deletion.adapter.ts):
    // реактивация, закоммиченная в этом окне, сохраняет строки живого
    // аккаунта; 0 затронутых строк — тихий успех (паттерн devices/tasks/contacts).
    await ctx.assertCurrent(job);
    await ctx.db.query(
      `DELETE FROM chat_uploads
        WHERE user_id = $1
          AND EXISTS (SELECT 1 FROM user_id u
            WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2)`,
      [job.userId, job.deletionId],
    );
  }
}
