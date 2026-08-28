import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { LiveKitClient } from '../voice-call/livekit.client';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { SPECIALIST_ROLES, SPECIALISTS } from '../voice-call/voice-call.types';
import { RoomService } from './room.service';

/** Провайдер встречи в voice_calls. Дальше сюда добавится 'zoom'. */
const PROVIDER = 'linkeon_room';

/**
 * Вход ассистента во встречу.
 *
 * Комната живёт отдельно (RoomService) и принадлежит людям. Здесь только
 * жизненный цикл присутствия ассистента в ней: позвали — вошёл, попросили —
 * вышел, все разошлись — вышел сам.
 */
@Injectable()
export class MeetingService {
  private readonly logger = new Logger(MeetingService.name);

  constructor(
    private readonly pg: PgService,
    private readonly calls: VoiceCallService,
    private readonly livekit: LiveKitClient,
    private readonly rooms: RoomService,
  ) {}

  /**
   * Имя владельца — из профиля, а не из токена.
   *
   * Раньше контроллер брал его как `u.name || 'пользователя'`, а guard кладёт
   * в request.user только { userId, sub, isAdmin }: поля name там нет и не
   * было. То есть фолбэк срабатывал ВСЕГДА, и на каждой встрече ассистент
   * представлялся «ассистент пользователя». Выглядело как случайный сбой,
   * было единственно возможным поведением — поймано на встрече 28.08.2026.
   */
  private async resolveOwnerName(userId: string): Promise<string> {
    try {
      const res = await this.pg.query(
        `SELECT NULLIF(TRIM(profile_data->>'name'), '') AS name
           FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      return res.rows[0]?.name || 'пользователя';
    } catch (e: any) {
      // Без имени встреча состоится, без ассистента — нет.
      this.logger.warn(`имя владельца встречи не получено (${userId}): ${e?.message}`);
      return 'пользователя';
    }
  }

  async join(
    userId: string,
    agentId: number,
    code: string,
  ): Promise<{ callId: string; title: string }> {
    const agentRes = await this.pg.query(
      `SELECT id, display_name, system_prompt, realtime_voice FROM agents WHERE id = $1 LIMIT 1`,
      [agentId],
    );
    const agent = agentRes.rows[0];
    if (!agent) throw new NotFoundException('agent not found');

    // Один активный вход на пользователя. Минута Realtime стоит реальных
    // денег, а без проверки N вкладок дают N оплачиваемых сессий. Тот же
    // индекс voice_calls_active_idx, что у звонка.
    const active = await this.pg.query(
      `SELECT id FROM voice_calls WHERE user_id = $1 AND status IN ('dialing','active') LIMIT 1`,
      [userId],
    );
    if (active.rows[0]) {
      throw new ConflictException({ message: 'call already in progress', callId: active.rows[0].id });
    }

    const room = await this.rooms.info(code);
    if (!room || !room.active) throw new NotFoundException('room not found');

    const callId = randomUUID();
    // Комната ВСТРЕЧИ, а не новая: ассистент идёт туда, где уже сидят люди.
    const roomName = `room_${room.code}`;

    await this.pg.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, provider, external_room)
       VALUES ($1, $2, $3, $4, 'dialing', $5, $6)`,
      [callId, userId, agentId, roomName, PROVIDER, room.code],
    );

    try {
      const preamble = await this.calls.buildPreamble(userId, agentId);
      const ownerName = await this.resolveOwnerName(userId);

      await this.livekit.dispatchAgent(roomName, {
        callId,
        userId,
        preamble,
        mode: 'meeting',
        agentName: agent.display_name,
        agentPersona: agent.system_prompt || '',
        agentVoice: agent.realtime_voice || undefined,
        ownerName,
        // Все специалисты, кроме самого ведущего: спрашивать себя незачем, а
        // предложение это сделать модель однажды примет всерьёз.
        specialists: Object.keys(SPECIALISTS)
          .filter((n) => SPECIALISTS[n] !== agentId)
          .map((n) => ({ name: n, role: SPECIALIST_ROLES[n] || '' })),
        callbackUrl: `${process.env.BACKEND_URL || 'https://my.linkeon.io'}/webhook/voice-call/internal`,
      });
    } catch (e: any) {
      // Запись, оставшаяся в 'dialing', намертво блокирует пользователю
      // следующую попытку — лимит «один активный вход» смотрит именно на неё.
      this.logger.error(`[join] call=${callId} не поднялся: ${e?.message}`);
      await this.pg.query(
        `UPDATE voice_calls SET status = 'failed', ended_at = now(), summary = $1 WHERE id = $2`,
        [`Вход во встречу не состоялся: ${e?.message}`, callId],
      );
      throw e;
    }

    this.logger.log(`[join] call=${callId} agent=${agentId} room=${room.code}`);
    return { callId, title: room.title };
  }

  /**
   * Во встрече появился первый живой участник.
   *
   * COALESCE обязателен: участники входят и выходят, и повторный вызов не
   * должен сдвигать момент начала — на него опирается ожидание в воркере.
   */
  async noteFirstHuman(callId: string): Promise<void> {
    await this.pg.query(
      `UPDATE voice_calls
          SET status = 'active', first_human_at = COALESCE(first_human_at, now())
        WHERE id = $1 AND status = 'dialing'`,
      [callId],
    );
  }

  /**
   * Пользователь попросил ассистента выйти.
   *
   * Комнату НЕ закрываем: она не наша по смыслу — в ней люди, и они продолжают
   * встречу без ассистента. Этим встреча принципиально отличается от звонка,
   * где markInterrupted закрывает комнату вместе с разговором.
   */
  async leave(callId: string): Promise<void> {
    await this.calls.markInterruptedKeepingRoom(callId);
  }
}
