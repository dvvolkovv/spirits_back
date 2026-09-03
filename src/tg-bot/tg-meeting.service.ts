import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from './tg-grammy.client';
import { MeetingService } from '../meeting/meeting.service';
import { RoomService } from '../meeting/room.service';
import { TalerIdRoomClient } from '../meeting/talerid-room.client';
import { parseMeetingLink, MeetingProvider } from '../meeting/meeting-link';

/**
 * Вход ассистента во встречу из телеграм-бота.
 *
 * В вебе ссылка на комнату превращается в карточку с кнопкой «Зайти». В боте
 * этого не было вовсе: владелец 03.09.2026 кинул ссылку Роману в личку, тот
 * открыл страницу (интернет у бота есть) и пересказал её содержимое — вежливо
 * и совершенно не по делу.
 *
 * Здесь тот же приём, что в вебе: ссылка замыкает ход, в модель не идём.
 * Иначе за каждую вставленную ссылку платим ход LLM и получаем два ответа —
 * приглашение и рассуждение ассистента о нём.
 */

/** Префикс callback_data. Лимит Telegram — 64 байта, коды заведомо короче. */
const JOIN_PREFIX = 'meet:';

@Injectable()
export class TgMeetingService {
  private readonly logger = new Logger(TgMeetingService.name);

  constructor(
    private readonly pg: PgService,
    private readonly grammy: TgGrammyClient,
    private readonly meetings: MeetingService,
    private readonly rooms: RoomService,
    private readonly talerIdRooms: TalerIdRoomClient,
  ) {}

  /**
   * Ассистент, который пойдёт во встречу.
   *
   * Тот же, с кем человек разговаривает в личке — правило один в один как в
   * вебе, где заходит тот, в чей чат кинули ссылку.
   */
  private async currentAgent(ownerId: string): Promise<{ id: number; name: string } | null> {
    const r = await this.pg.query(
      `SELECT a.id, COALESCE(a.display_name, a.name) AS name
         FROM ai_profiles_consolidated p
         JOIN agents a ON a.name = p.preferred_agent
        WHERE p.user_id = $1 LIMIT 1`,
      [ownerId],
    );
    const row = r.rows[0];
    return row ? { id: Number(row.id), name: String(row.name) } : null;
  }

  /**
   * Ссылка на встречу в сообщении.
   *
   * @returns true — сообщение обработано, дальше в модель не идём.
   */
  async tryHandleLink(chatId: number, text: string, ownerId: string): Promise<boolean> {
    const link = parseMeetingLink(text);
    if (!link) return false;

    const found = await this.lookup(link.provider, link.code);
    // Комнаты нет, она закрыта или под паролем — значит это была обычная
    // ссылка в разговоре, а не приглашение. Молчим и пропускаем ход в модель:
    // пусть ассистент ответит как обычно.
    if (!found) return false;

    const agent = await this.currentAgent(ownerId);
    const who = agent ? `${agent.name} зайдёт во встречу` : 'Ассистент зайдёт во встречу';

    await this.grammy.sendMessage(chatId, `🎤 <b>${escapeHtml(found.title)}</b>\n${who}.`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Зайти во встречу', callback_data: `${JOIN_PREFIX}${link.provider}:${link.code}` },
        ]],
      },
    });
    return true;
  }

  private async lookup(
    provider: MeetingProvider,
    code: string,
  ): Promise<{ title: string } | null> {
    try {
      if (provider === 'talerid') {
        const r = await this.talerIdRooms.info(code);
        if (!r || !r.isActive || r.requiresPassword) return null;
        return { title: r.title || r.creatorName || 'Встреча' };
      }
      const r = await this.rooms.info(code);
      return r?.active ? { title: r.title || 'Встреча' } : null;
    } catch (e: any) {
      this.logger.warn(`комната ${provider}/${code} не проверена: ${e?.message}`);
      return null;
    }
  }

  /** Нажали «Зайти во встречу». */
  async handleJoinCallback(cb: any, ownerId: string): Promise<void> {
    const rest = String(cb.data || '').slice(JOIN_PREFIX.length);
    const sep = rest.indexOf(':');
    const provider = (sep > 0 ? rest.slice(0, sep) : 'linkeon') as MeetingProvider;
    const code = sep > 0 ? rest.slice(sep + 1) : rest;

    const agent = await this.currentAgent(ownerId);
    if (!agent) {
      await this.grammy.answerCallbackQuery(cb.id, { text: 'Сначала выбери ассистента: /assistants' });
      return;
    }

    try {
      await this.meetings.join(ownerId, agent.id, code, provider);
      // Отвечаем на callback ДО отправки сообщения: Telegram гасит «часики» на
      // кнопке только по нему, а вход занимает несколько секунд.
      await this.grammy.answerCallbackQuery(cb.id, {});
      await this.grammy.sendMessage(cb.message.chat.id, `${agent.name} во встрече.`);
    } catch (e: any) {
      // Причины ожидаемые и разные: комната закрылась, уже идёт разговор,
      // комната под паролем. Человеку нужен текст, а не молчащая кнопка.
      const msg = e?.status === 409 || /already in progress/i.test(e?.message || '')
        ? 'Разговор уже идёт — заверши его и попробуй снова.'
        : 'Не получилось зайти: комната недоступна.';
      await this.grammy.answerCallbackQuery(cb.id, { text: msg });
      this.logger.warn(`[tg] вход во встречу ${provider}/${code} не удался: ${e?.message}`);
    }
  }

  /** Это нажатие нашей кнопки? */
  static isJoin(data: string): boolean {
    return data.startsWith(JOIN_PREFIX);
  }
}

/** Название комнаты приходит от людей и уезжает в HTML-разметку Telegram. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
