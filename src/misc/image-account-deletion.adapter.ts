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
  DeletionJobSpec,
  DeletionPlan,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { MiscService } from './misc.service';

/**
 * Task 12 — generated images при удалении аккаунта.
 *
 * Каноническая строка — generated_images: она переживает немедленное удаление
 * истории чата (см. шапку chat-file-account-deletion.adapter.ts), поэтому
 * image.purge планируется исчерпывающе по строкам удалённого поколения
 * (keyset-пагинация, generation predicate в EXISTS, без потолка на число
 * строк). В payload живёт один технический imageId: prompt (личный текст),
 * userId и полные URL с доменами план не покидают — это дополнительно
 * проверяет fail-closed sanitizer плана.
 *
 * Purge строгий: каждый owned объект (MinIO linkeon-assets, локальный
 * /static через checked ownStaticPath, легаси Yandex S3 своим настроенным
 * клиентом) удаляется с подтверждением и ДО удаления row; любой
 * неподтверждённый исход — retry, row и технические id переживают попытку.
 * Ключи никогда не вычисляются из произвольного URL. deleteS3Objects-style
 * allSettled-подавление здесь не используется.
 */

/** Сколько строк generated_images читать за один запрос discovery. */
export const IMAGE_PAGE_SIZE = 500;

export interface ImageDiscovery extends DeletionDiscovery {
  /** Размер keyset-страницы (тесты); по умолчанию IMAGE_PAGE_SIZE. */
  pageSize?: number;
}

export async function discoverImageDeletion(ctx: ImageDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  const pageSize = ctx.pageSize ?? IMAGE_PAGE_SIZE;
  const jobs: DeletionJobSpec[] = [];

  let lastId = 0;
  for (;;) {
    const res = await db.query(
      `SELECT g.id FROM generated_images g
        WHERE g.user_id = $1
          AND g.id > $2
          AND EXISTS (
            SELECT 1 FROM user_id u
            WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $3
          )
        ORDER BY g.id
        LIMIT $4`,
      [account.userId, lastId, account.deletionId, pageSize],
    );
    const rows = res.rows ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = Number(row.id);
      lastId = Math.max(lastId, id);
      jobs.push({
        resourceType: 'image.purge',
        resourceKey: String(id),
        phase: 'purge',
        payload: { imageId: id },
      });
    }
  }
  return { jobs, skips: [] };
}

@Injectable()
export class ImageAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['image.purge'];

  constructor(
    private readonly misc: MiscService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'image.purge') {
      throw new Error('unsupported_deletion_resource');
    }
    // Payload мог прийти только из нашего discovery, но purge исполняется
    // через 30 дней: imageId перепроверяется fail-closed. Рассогласование —
    // retry db, а не слепое удаление.
    const imageId = job.payload?.imageId;
    if (typeof imageId !== 'number' || !Number.isSafeInteger(imageId) || imageId <= 0) {
      throw new DeletionRetryError('db');
    }

    await ctx.assertCurrent(job);
    try {
      await this.misc.deleteGeneratedImageForDeletion(job.userId, imageId, job.deletionId);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
    // Внешние операции (MinIO/Yandex/fs) могли занять время: перед тем как
    // считать job выполненным, поколение и lease перепроверяются.
    await ctx.assertCurrent(job);
  }
}
