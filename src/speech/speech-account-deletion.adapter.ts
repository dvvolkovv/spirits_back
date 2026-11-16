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
import { SpeechService } from './speech.service';

/**
 * Task 13 — speech_clips и speech_listens при удалении аккаунта.
 *
 * Канонические строки переживают немедленное удаление истории чата, поэтому
 * discovery планируется исчерпывающе по строкам удалённого поколения
 * (keyset-пагинация по uuid, generation predicate в EXISTS, без потолка на
 * число строк) и сохраняет из каждой строки ТОЛЬКО технический id
 * ({clipId}/{listenId}): тексты, cache_key и URL план не покидают — это
 * дополнительно проверяет fail-closed sanitizer плана.
 *
 * Объект клипа audio/<cache_key>.mp3 — общий кэш (тот же текст тем же голосом
 * у соседа даёт ту же строку cache_key и тот же объект MinIO): перед удалением
 * объекта считается число ЧУЖИХ строк с тем же cache_key, при чужих ссылках
 * объект пропускается, а своя row удаляется. Listen-куски
 * audio/listen/<cache_key>-<nonce>-<i>.mp3 содержат случайный nonce строки и
 * никому не общие — удаляются строго по одному ДО удаления row. Ключи никогда
 * не вычисляются из произвольных строк payload.
 */

/** Сколько строк speech_clips/speech_listens читать за один запрос discovery. */
export const SPEECH_PAGE_SIZE = 500;

/** Нулевой uuid — нижняя граница keyset-пагинации первой страницы. */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export interface SpeechDiscovery extends DeletionDiscovery {
  /** Размер keyset-страницы (тесты); по умолчанию SPEECH_PAGE_SIZE. */
  pageSize?: number;
}

export async function discoverSpeechDeletion(ctx: SpeechDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  const pageSize = ctx.pageSize ?? SPEECH_PAGE_SIZE;
  const jobs: DeletionJobSpec[] = [];

  let lastId: string | null = null;
  for (;;) {
    const res = await db.query(
      `SELECT s.id FROM speech_clips s
        WHERE s.user_id = $1
          AND s.id > coalesce($2::uuid, '${ZERO_UUID}'::uuid)
          AND EXISTS (
            SELECT 1 FROM user_id u
            WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $3
          )
        ORDER BY s.id
        LIMIT $4`,
      [account.userId, lastId, account.deletionId, pageSize],
    );
    const rows = res.rows ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = String(row.id);
      lastId = id;
      jobs.push({
        resourceType: 'speech.purge',
        resourceKey: id,
        phase: 'purge',
        payload: { clipId: id },
      });
    }
  }

  lastId = null;
  for (;;) {
    const res = await db.query(
      `SELECT l.id FROM speech_listens l
        WHERE l.user_id = $1
          AND l.id > coalesce($2::uuid, '${ZERO_UUID}'::uuid)
          AND EXISTS (
            SELECT 1 FROM user_id u
            WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $3
          )
        ORDER BY l.id
        LIMIT $4`,
      [account.userId, lastId, account.deletionId, pageSize],
    );
    const rows = res.rows ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = String(row.id);
      lastId = id;
      jobs.push({
        resourceType: 'listen.purge',
        resourceKey: id,
        phase: 'purge',
        payload: { listenId: id },
      });
    }
  }

  return { jobs, skips: [] };
}

@Injectable()
export class SpeechAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['speech.purge', 'listen.purge'];

  constructor(
    private readonly speech: SpeechService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType === 'speech.purge') {
      // Payload мог прийти только из нашего discovery, но purge исполняется
      // через 30 дней: clipId перепроверяется fail-closed (строго uuid —
      // формат PK speech_clips). Рассогласование — retry db, а не слепое
      // удаление.
      const clipId = job.payload?.clipId;
      if (typeof clipId !== 'string' || !SpeechService.DELETION_UUID_RE.test(clipId)) {
        throw new DeletionRetryError('db');
      }
      await ctx.assertCurrent(job);
      try {
        await this.speech.deleteSpeechClipForDeletion(job.userId, clipId, job.deletionId);
      } catch (error) {
        if (error instanceof DeletionCancelledError) throw error;
        if (error instanceof DeletionRetryError) throw error;
        throw new DeletionRetryError(deletionErrorKind(error));
      }
      // Внешние операции (MinIO) могли занять время: перед тем как считать job
      // выполненным, поколение и lease перепроверяются.
      await ctx.assertCurrent(job);
      return;
    }

    if (job.resourceType === 'listen.purge') {
      const listenId = job.payload?.listenId;
      if (typeof listenId !== 'string' || !SpeechService.DELETION_UUID_RE.test(listenId)) {
        throw new DeletionRetryError('db');
      }
      await ctx.assertCurrent(job);
      try {
        await this.speech.deleteListenForDeletion(job.userId, listenId, job.deletionId);
      } catch (error) {
        if (error instanceof DeletionCancelledError) throw error;
        if (error instanceof DeletionRetryError) throw error;
        throw new DeletionRetryError(deletionErrorKind(error));
      }
      await ctx.assertCurrent(job);
      return;
    }

    throw new Error('unsupported_deletion_resource');
  }
}
