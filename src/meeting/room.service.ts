import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { LiveKitClient } from '../voice-call/livekit.client';
import { generateRoomCode, isValidRoomCode } from './room-code';

export interface RoomInfo {
  code: string;
  title: string;
  active: boolean;
}

/** Длиннее в списке участников не нужно — это подпись, а не биография. */
const MAX_DISPLAY_NAME = 64;

/**
 * Голосовые комнаты Linkeon.
 *
 * Комната принадлежит людям, а не ассистенту: он в неё заходит и выходит, а
 * она живёт своей жизнью. Отсюда и разделение — вход ассистента лежит в
 * MeetingService, здесь только сама комната.
 */
@Injectable()
export class RoomService {
  private readonly logger = new Logger(RoomService.name);

  constructor(
    private readonly pg: PgService,
    private readonly livekit: LiveKitClient,
  ) {}

  /**
   * Имя комнаты в LiveKit.
   *
   * Префикс обязателен: комнаты звонков называются `voice_<uuid>`, и без
   * разделения коды встреч однажды столкнулись бы с чужими именами.
   */
  private roomName(code: string): string {
    return `room_${code}`;
  }

  async create(userId: string, title?: string): Promise<{ code: string; title: string }> {
    const code = generateRoomCode();
    const clean = (title || '').trim().slice(0, 200) || null;
    await this.pg.query(
      `INSERT INTO meeting_rooms (code, owner_user_id, title) VALUES ($1, $2, $3)`,
      [code, userId, clean],
    );
    this.logger.log(`[create] комната ${code} у ${userId}`);
    return { code, title: clean || 'Встреча' };
  }

  /**
   * Справка о комнате. null — такой нет.
   *
   * Закрытая комната возвращается с `active: false`, а не как отсутствующая:
   * снаружи различать их не нужно (контроллер отвечает одинаково), но внутри
   * это разные случаи, и `joinGuest` обязан их видеть.
   */
  async info(code: string): Promise<RoomInfo | null> {
    // Проверка ДО базы: ручка публичная, и гонять в запрос мусор или перебор
    // незачем.
    if (!isValidRoomCode(code)) return null;
    const upper = code.toUpperCase();
    const res = await this.pg.query(
      `SELECT code, title, closed_at FROM meeting_rooms WHERE code = $1`,
      [upper],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { code: row.code, title: row.title || 'Встреча', active: !row.closed_at };
  }

  async joinGuest(code: string, name: string): Promise<{ token: string; wsUrl: string }> {
    const room = await this.info(code);
    if (!room || !room.active) throw new NotFoundException('room not found');

    // identity уникальна на каждый вход. LiveKit считает её ключом участника:
    // два человека с одинаковой identity — это один участник, и второй вход
    // выкидывает первого из комнаты. У тёзок так бы и вышло.
    const identity = `guest_${randomUUID()}`;
    const display = (name || '').trim().slice(0, MAX_DISPLAY_NAME) || 'Гость';

    const token = await this.livekit.userToken(this.roomName(room.code), identity, display);
    return {
      token,
      wsUrl: process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_URL || 'ws://localhost:7880',
    };
  }

  async close(code: string): Promise<void> {
    const upper = (code || '').toUpperCase();
    await this.pg.query(
      `UPDATE meeting_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL`,
      [upper],
    );
    await this.livekit.closeRoom(this.roomName(upper));
  }
}
