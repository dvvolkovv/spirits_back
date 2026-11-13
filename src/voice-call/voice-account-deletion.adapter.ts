import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import { DeletionRetryError, deletionErrorKind } from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscoverer,
  DeletionExecution,
  DeletionJobRow,
  DeletionJobSpec,
  DeletionResourceType,
} from '../account-deletion/account-deletion.types';
import { AttendeeClient } from '../meeting/attendee.client';
import { VoiceCallService } from './voice-call.service';

/**
 * Task 10 — голосовые звонки и встречи при удалении аккаунта.
 *
 * Останавливаются ТОЛЬКО ресурсы удалённого аккаунта: его боты выводятся из
 * чужих встреч, его звонок помечается остановленным. Общие комнаты
 * (meeting_rooms и комнаты, где есть звонки других user_id) НЕ закрываются —
 * закрытие выкинуло бы остальных участников из-за удаления одного аккаунта;
 * из них убираются только наши агенты. RoomService.close из этого пути не
 * вызывается никогда.
 *
 * Fail-closed на каждом внешнем шаге: Attendee null (состояние бота
 * неизвестно) и любой неподтверждённый исход LiveKit — retry, а
 * external_bot_id сохраняется, чтобы повторная попытка знала, кого выводить.
 *
 * В payload живут только технические callId/externalBotId/roomKind —
 * external_url (Zoom-ссылка с zak-токеном) не покидает базу: sanitizer
 * проверяет ключи, а discovery её даже не выбирает.
 */

export const discoverVoiceDeletion: DeletionDiscoverer = async ({ db, account }) => {
  // Один запрос на всё: живой/забытый звонок + два признака общей комнаты.
  // roomKind='shared', когда в той же комнате есть звонок другого user_id
  // ИЛИ комната — persistent meeting_rooms (room_<code>, не закрыта).
  // Generation predicate в EXISTS: планируем, лишь пока строка удалённого
  // поколения на месте (после reactivation план пустой).
  const res = await db.query(
    `SELECT c.id, c.external_bot_id,
            EXISTS (
              SELECT 1 FROM voice_calls o
              WHERE o.room_name = c.room_name AND o.user_id <> c.user_id
            ) AS shared_room,
            EXISTS (
              SELECT 1 FROM meeting_rooms m
              WHERE m.closed_at IS NULL
                AND c.room_name LIKE 'room\\_%'
                AND m.code = substr(c.room_name, 6)
            ) AS persistent_room
       FROM voice_calls c
      WHERE c.user_id = $1
        AND (c.status IN ('dialing','active') OR c.external_bot_id IS NOT NULL)
        AND EXISTS (
          SELECT 1 FROM user_id u
          WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2
        )
      ORDER BY c.id`,
    [account.userId, account.deletionId],
  );

  const jobs: DeletionJobSpec[] = [];
  for (const row of res.rows) {
    const callId = String(row.id);
    const shared = row.shared_room === true || row.persistent_room === true;
    jobs.push({
      resourceType: 'voice.stop',
      resourceKey: callId,
      phase: 'immediate',
      payload: {
        callId,
        externalBotId: typeof row.external_bot_id === 'string' ? row.external_bot_id : null,
        roomKind: shared ? 'shared' : 'sole',
      },
    });
  }
  return { jobs, skips: [] };
};

@Injectable()
export class VoiceAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['voice.stop'];

  constructor(
    private readonly voice: VoiceCallService,
    // Необязательный, как и в VoiceCallService: на стендах без Attendee
    // внешних ботов не бывает. Но если бот в задаче есть, а клиента нет —
    // это неизвестный исход и fail-closed retry.
    @Optional() private readonly attendee: AttendeeClient | undefined,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    switch (job.resourceType) {
      case 'voice.stop': {
        await ctx.assertCurrent(job);
        const callId = typeof job.payload?.callId === 'string' ? job.payload.callId : job.resourceKey;
        const externalBotId = typeof job.payload?.externalBotId === 'string'
          ? job.payload.externalBotId
          : null;
        const shared = job.payload?.roomKind === 'shared';

        if (externalBotId) {
          if (!this.attendee) throw new DeletionRetryError('external_unknown');
          // Tri-state Attendee: true — вывели, false — бота уже нет
          // (терминальное состояние, подтверждение), null — НЕИЗВЕСТНО.
          // Исключение сети приравниваем к null: обе ветки fail-closed.
          const removed = await this.attendee.removeBot(externalBotId).catch(() => null);
          if (removed === null) throw new DeletionRetryError('external_unknown');
          // Бот гарантированно вне встречи — теперь можно забыть внешний ID.
          await ctx.assertCurrent(job);
          await this.voice.clearReleasedBotForDeletion(callId, job.deletionId, job.userId);
        }

        await ctx.assertCurrent(job);
        let stopped: boolean;
        try {
          // shared — комната остаётся жить, убираем только агентов; sole —
          // личная комната закрывается целиком. Оба strict: подтверждённый
          // boolean, ошибки не глотаются.
          stopped = shared
            ? await this.voice.markInterruptedKeepingRoomStrict(callId, job.deletionId)
            : await this.voice.markInterruptedStrict(callId, job.deletionId);
        } catch (error) {
          throw new DeletionRetryError(deletionErrorKind(error));
        }
        if (!stopped) throw new DeletionRetryError('external_unknown');
        await ctx.assertCurrent(job);
        return;
      }
      default:
        throw new Error('unsupported_deletion_resource');
    }
  }
}
