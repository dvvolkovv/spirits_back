import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionErrorKind,
  deletionResourceHash,
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
import { VoiceAvatarService } from './voice-avatar.service';

/**
 * Task 14 — клон голоса ElevenLabs при удалении аккаунта.
 *
 * Каноническая строка — user_voice (PK user_id: не более одного клона на
 * пользователя, keyset-пагинация не нужна). Discovery снимает snapshot
 * внешнего elevenlabs_voice_id под generation predicate ДО любого stop и
 * сохраняет в payload только технический {voiceId}: voice_descriptor,
 * sample_url и userId план не покидают — это дополнительно проверяет
 * fail-closed sanitizer плана. У пользователей без elevenlabs_voice_id
 * внешнего ресурса нет — job не создаётся. Фоновое клонирование уже
 * fenced в Task 11 (active-гейт в profileAndClone + компенсация клона),
 * поэтому новый внешний id после discovery не появится.
 *
 * Purge строгий: deleteCloneConfirmed возвращает ПОДТВЕРЖДЁННЫЙ исход
 * ('deleted' 2xx / 'absent' 404); любой неподтверждённый исход (нет ключа,
 * timeout, 5xx, пустая ошибка) — retry, при котором row и внешний id
 * переживают попытку. Локальная row удаляется только после подтверждения и
 * только под generation predicate; отсутствие строки — идемпотентный успех
 * без внешнего вызова. Интерактивные deleteClone/removeVoice для живых
 * пользователей не меняются.
 */

/** Fail-closed проверка внешнего id: управляющие символы и пробелы недопустимы. */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export async function discoverVoiceAvatarDeletion(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  const res = await db.query(
    `SELECT v.elevenlabs_voice_id FROM user_voice v
      WHERE v.user_id = $1
        AND v.elevenlabs_voice_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM user_id u
          WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2
        )`,
    [account.userId, account.deletionId],
  );
  const jobs: DeletionJobSpec[] = [];
  for (const row of res.rows ?? []) {
    const voiceId = row?.elevenlabs_voice_id;
    // Fail-closed: неизвестный формат внешнего id — не job (санitizer плана
    // всё равно бы отверг unsafe resourceKey/payload, но молча ломать collect
    // нельзя). Строка без id внешнего ресурса не имеет — пропускаем.
    if (typeof voiceId !== 'string' || voiceId.trim() === '' || voiceId.length > 128) {
      continue;
    }
    jobs.push({
      resourceType: 'elevenlabs-voice.purge',
      // resourceKey не должен содержать userId и обязан отвечать формату —
      // детерминированный хэш внешнего id (по образцу chat-file/avatar).
      resourceKey: deletionResourceHash('elevenlabs-voice', voiceId),
      phase: 'purge',
      payload: { voiceId },
    });
  }
  return { jobs, skips: [] };
}

@Injectable()
export class VoiceAvatarAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['elevenlabs-voice.purge'];

  constructor(
    private readonly voiceAvatar: VoiceAvatarService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'elevenlabs-voice.purge') {
      throw new Error('unsupported_deletion_resource');
    }
    // Payload мог прийти только из нашего discovery, но purge исполняется
    // через 30 дней: voiceId перепроверяется fail-closed. Рассогласование —
    // retry db, а не слепой внешний вызов.
    const voiceId = job.payload?.voiceId;
    if (typeof voiceId !== 'string' || voiceId.trim() === '' || voiceId.length > 128
      || hasControlChars(voiceId)) {
      throw new DeletionRetryError('db');
    }

    try {
      await ctx.assertCurrent(job);
      const existing = await ctx.db.query(
        `SELECT 1 FROM user_voice v
          WHERE v.user_id = $1 AND v.elevenlabs_voice_id = $2
            AND EXISTS (
              SELECT 1 FROM user_id u
              WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $3
            )`,
        [job.userId, voiceId, job.deletionId],
      );
      // Строки удалённого поколения нет (уже вычищена или поколение сменилось):
      // идемпотентный успех без внешнего вызова — повторный delete клона
      // не нужен, row удалять нечего.
      if ((existing.rowCount ?? existing.rows?.length ?? 0) === 0) return;

      // assertCurrent ДО внешнего вызова; неподтверждённый исход провайдер
      // никогда не трактуется как успех (DeletionRetryError из сервиса).
      await this.voiceAvatar.deleteCloneConfirmed(voiceId);

      // Внешний вызов мог занять время: поколение и lease перепроверяются
      // ДО удаления локальной row.
      await ctx.assertCurrent(job);
      await ctx.db.query(
        `DELETE FROM user_voice v
          WHERE v.user_id = $1 AND v.elevenlabs_voice_id = $2
            AND EXISTS (
              SELECT 1 FROM user_id u
              WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $3
            )`,
        [job.userId, voiceId, job.deletionId],
      );
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}