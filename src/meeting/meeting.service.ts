import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { LiveKitClient } from '../voice-call/livekit.client';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { SPECIALIST_ROLES, SPECIALISTS } from '../voice-call/voice-call.types';
import { RoomService } from './room.service';
import { TalerIdRoomClient } from './talerid-room.client';
import { MeetingProvider } from './meeting-link';

/** Провайдер встречи в voice_calls. Дальше сюда добавится 'zoom'. */
const PROVIDER = 'linkeon_room';
/** Он же для чужих комнат Taler ID. */
const PROVIDER_TALERID = 'talerid';

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
    private readonly talerIdRooms: TalerIdRoomClient,
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
    provider: MeetingProvider = 'linkeon',
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

    const isForeign = provider === 'talerid';
    const callId = randomUUID();

    // Куда идёт ассистент и как называется комната — единственное, чем
    // отличаются свои встречи от чужих. Всё остальное ниже общее.
    let title: string;
    let roomName: string;
    let external: { url: string; token: string } | undefined;

    if (isForeign) {
      const info = await this.talerIdRooms.info(code);
      if (!info || !info.isActive) throw new NotFoundException('room not found');
      // Пароль в v1 не поддержан. Отказ внятный: молчаливое падение в 500
      // выглядит как поломка, а это ожидаемое ограничение.
      if (info.requiresPassword) {
        throw new ConflictException({ message: 'password-protected room is not supported yet' });
      }
      title = info.title || info.creatorName || 'Встреча';
      // Наша комната пустая и нужна ровно ради job: жизненный цикл, учёт и
      // reaper завязаны на voice_calls и на disconnect из НАШЕЙ комнаты.
      // Разговор при этом идёт целиком в комнате Taler ID.
      roomName = `talerid_${code}`;
    } else {
      const room = await this.rooms.info(code);
      if (!room || !room.active) throw new NotFoundException('room not found');
      title = room.title;
      // Комната ВСТРЕЧИ, а не новая: ассистент идёт туда, где уже сидят люди.
      roomName = `room_${room.code}`;
    }

    await this.pg.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, provider, external_room)
       VALUES ($1, $2, $3, $4, 'dialing', $5, $6)`,
      [callId, userId, agentId, roomName, isForeign ? PROVIDER_TALERID : PROVIDER, code],
    );

    try {
      const preamble = await this.calls.buildPreamble(userId, agentId);
      const ownerName = await this.resolveOwnerName(userId);

      if (isForeign) {
        // Токен берём здесь, а не выше: он живёт шесть часов, и отсчёт лучше
        // начинать как можно позже. Имя — то же, что мы показываем в своих
        // комнатах, чтобы участники Taler ID видели, кто к ним пришёл.
        const t = await this.talerIdRooms.join(code, `${agent.display_name} · ассистент ${ownerName}`);
        if (!t) throw new NotFoundException('room not found');
        external = { url: t.url, token: t.token };
      }

      await this.livekit.dispatchAgent(roomName, {
        callId,
        userId,
        preamble,
        mode: 'meeting',
        agentName: agent.display_name,
        agentPersona: agent.system_prompt || '',
        agentVoice: agent.realtime_voice || undefined,
        ownerName,
        // Внешняя комната: воркер повесит на неё вход и выход сессии.
        // Для своих встреч поля нет вовсе — поведение воркера не меняется.
        ...(external ? { provider: PROVIDER_TALERID, externalUrl: external.url, externalToken: external.token } : {}),
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

    this.logger.log(`[join] call=${callId} agent=${agentId} provider=${provider} room=${code}`);
    return { callId, title };
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
