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
  DeletionSkip,
} from '../account-deletion/account-deletion.types';
import { VideoService } from './video.service';

/**
 * Task 12 — video_jobs при удалении аккаунта.
 *
 * Каноническая строка — video_jobs: purge читает её сохранённые URL (включая
 * video-uploads/<userId>/… — ИЗ СТРОКИ, не из payload), удаляет каждый owned
 * MinIO-объект, локальный финальный MP4/JPG и staging-каталог _veoconcat
 * строго (await, без allSettled-подавления), и только затем в transaction
 * удаляет row; TG delivery row (tg_bot_video_jobs) уходит FK-cascade вместе
 * с video job.
 *
 * Omni interaction id (kling_task_id) — НЕ deletable файл и не наш объект:
 * cancel/delete API у провайдера не существует, поэтому discovery фиксирует
 * один безопасный skip video.provider/unsupported_external на план (без самого
 * id — он payload-гигиену не прошёл бы и пользы не несёт), а purge никаких
 * провайдерских методов не вызывает. В payload живёт один технический
 * videoJobId: prompt, userId и пути план не покидают.
 */

/** Сколько строк video_jobs читать за один запрос discovery. */
export const VIDEO_PAGE_SIZE = 500;

/** Нулевой uuid — нижняя граница keyset-пагинации первой страницы. */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export interface VideoDiscovery extends DeletionDiscovery {
  /** Размер keyset-страницы (тесты); по умолчанию VIDEO_PAGE_SIZE. */
  pageSize?: number;
}

export async function discoverVideoDeletion(ctx: VideoDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  const pageSize = ctx.pageSize ?? VIDEO_PAGE_SIZE;
  const jobs: DeletionJobSpec[] = [];
  let providerSeen = false;

  let lastId: string | null = null;
  for (;;) {
    const res = await db.query(
      `SELECT v.id, v.kling_task_id FROM video_jobs v
        WHERE v.user_id = $1
          AND v.id > coalesce($2::uuid, '${ZERO_UUID}'::uuid)
          AND EXISTS (
            SELECT 1 FROM user_id u
            WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $3
          )
        ORDER BY v.id
        LIMIT $4`,
      [account.userId, lastId, account.deletionId, pageSize],
    );
    const rows = res.rows ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = String(row.id);
      lastId = id;
      if (row.kling_task_id) providerSeen = true;
      jobs.push({
        resourceType: 'video-job.purge',
        resourceKey: id,
        phase: 'purge',
        payload: { videoJobId: id },
      });
    }
  }

  const skips: DeletionSkip[] = providerSeen
    ? [{ resourceType: 'video.provider', reason: 'unsupported_external' }]
    : [];
  return { jobs, skips };
}

@Injectable()
export class VideoAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['video-job.purge'];

  constructor(
    private readonly video: VideoService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'video-job.purge') {
      throw new Error('unsupported_deletion_resource');
    }
    // Payload мог прийти только из нашего discovery, но purge исполняется
    // через 30 дней: videoJobId перепроверяется fail-closed (SAFE-токен без
    // '/' и traversal проверяет доменный метод — он же seed производных
    // путей). Рассогласование — retry db, а не слепое удаление.
    const videoJobId = job.payload?.videoJobId;
    if (typeof videoJobId !== 'string' || videoJobId.length === 0) {
      throw new DeletionRetryError('db');
    }

    await ctx.assertCurrent(job);
    try {
      await this.video.deleteVideoForDeletion(job.userId, videoJobId, job.deletionId);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
    // Внешние операции (MinIO/fs) могли занять время: перед тем как считать
    // job выполненным, поколение и lease перепроверяются.
    await ctx.assertCurrent(job);
  }
}
