import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../../common/services/pg.service';
import { LEGACY_FRESH_FUTURE_SLACK_MS, LEGACY_FRESH_MIN_MS } from './after-reset';
import { errKind, logId } from '../chat-uploads/err-kind';

/**
 * Коды своих отказов reset(): в журнал идёт только вид ошибки (errKind) —
 * по коду отказ отличим от сбоя базы, а текст не нужен.
 */
const CONTEXT_RESET_INVALID_TIME = 'INVALID_RESET_TIME';
const CONTEXT_RESET_ACCOUNT_DELETED = 'ACCOUNT_DELETED';

function resetError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Точка «Чистого листа» на пару «пользователь + ассистент»
 * (spec 2026-11-17-context-reset-design.md). После точки ассистент помнит
 * только новый разговор и профиль; лента при этом одна и не прерывается.
 *
 * Точка хранится на сервере, а не во вкладке: иначе с телефона, в рутине или
 * в «Пути» ассистент снова смешал бы старое с новым.
 */
@Injectable()
export class ChatContextResetService {
  constructor(private readonly pg: PgService) {}

  async migrate(): Promise<void> {
    // .sql в dist не копируется (nest-cli.json) — второй путь ведёт в src:
    // после сборки сервис лежит в dist/chat/context-reset, и «..» ровно три.
    const candidates = [
      path.join(__dirname, 'migrations', '001_chat_context_resets.sql'),
      path.join(__dirname, '..', '..', '..', 'src', 'chat', 'context-reset', 'migrations', '001_chat_context_resets.sql'),
    ];
    const migrationPath = candidates.find((c) => fs.existsSync(c));
    if (!migrationPath) throw new Error('chat-context-resets migration 001 not found');
    await this.pg.query(fs.readFileSync(migrationPath, 'utf8'));
  }

  // assistantId — строкой из query или числом из JSON-тела: в базе всегда текст.
  async get(userId: string, assistantId: string | number): Promise<Date | null> {
    const { rows } = await this.pg.query(
      'SELECT reset_at FROM chat_context_resets WHERE user_id = $1 AND assistant_id = $2',
      [userId, String(assistantId)],
    );
    return rows[0]?.reset_at ? new Date(rows[0].reset_at) : null;
  }

  /**
   * Точка пары или null — для читателей, которым сбой чтения не повод
   * отказывать (spec 2026-11-17-context-reset, «Риски»): ход, звонок, план и
   * лента идут с прежней памятью — хуже, чем с чистой, но лучше, чем никак.
   *
   * warn получает только id ассистента и вид ошибки (errKind) — по правилу
   * журнала памяти загрузок: без userId (у телефонных аккаунтов это номер
   * телефона), ключа сессии и текста ошибки (pg может повторять параметры
   * запроса), а текста разговора тем более. Нет колбэка — сбой
   * проглатывается молча (лента: черты нет, история есть).
   *
   * Статический и с сервисом первым параметром: у потребителей сервис
   * @Optional (нет его — точки нет), а их спеки подменяют сервис объектом с
   * одним `get` — экземплярный метод эти подмены сломал бы.
   */
  static async getOrNull(
    resets: Pick<ChatContextResetService, 'get'> | null | undefined,
    userId: string,
    assistantId: string | number,
    warn?: (msg: string) => void,
  ): Promise<Date | null> {
    if (!resets) return null;
    try {
      return (await resets.get(userId, assistantId)) ?? null;
    } catch (e: any) {
      warn?.(`context reset read failed (assistant ${logId(assistantId)}): ${errKind(e)}`);
      return null;
    }
  }

  /**
   * Ставит точку и возвращает действующую. `at` не задан (`undefined` или
   * `null`) — точка «сейчас» по часам базы (`now()`), тем же, что у
   * created_at сообщений. Точка только движется вперёд: два нажатия в разных
   * вкладках или запоздалая метка старого клиента не возвращают ассистенту
   * забытое.
   *
   * Явное время вне окна [LEGACY_FRESH_MIN_MS, now + окно] или Invalid Date —
   * ошибка (code INVALID_RESET_TIME), а не запись: из-за GREATEST точка из
   * будущего вечна и стёрла бы ассистенту память навсегда; точка в 1970 под
   * видом чистого листа вернула бы всю старую историю; Invalid Date иначе
   * всплыл бы невнятной ошибкой Postgres. Не обрезаем до now — почему, см.
   * LEGACY_FRESH_FUTURE_SLACK_MS.
   *
   * Удалённому аккаунту (user_id.state = 'deleted' — тот же признак, что у
   * IdentityService.isDeleted) точка не пишется — ошибка 'account deleted'
   * (code ACCOUNT_DELETED).
   * Выданный до удаления access-токен живёт до двух часов, а core-удаление
   * точки уже прошло: новая строка осталась бы сиротой навсегда. Нет строки
   * в user_id или state другой — пишем, как раньше. Проверка и запись — одним
   * выражением, без отдельного чтения перед записью.
   */
  async reset(userId: string, assistantId: string | number, at?: Date | null): Promise<Date> {
    if (at !== undefined && at !== null) {
      const t = at.getTime();
      if (!Number.isFinite(t) || t < LEGACY_FRESH_MIN_MS || t > Date.now() + LEGACY_FRESH_FUTURE_SLACK_MS) {
        throw resetError('invalid context reset time', CONTEXT_RESET_INVALID_TIME);
      }
    }
    // ::text у параметров: $1 стоит и в списке вставки (text), и в сравнении
    // с internal_id (varchar) — без явного типа Postgres мог бы вывести разные.
    const { rows } = await this.pg.query(
      `INSERT INTO chat_context_resets (user_id, assistant_id, reset_at)
       SELECT $1::text, $2::text, COALESCE($3::timestamptz, now())
        WHERE NOT EXISTS (
          SELECT 1 FROM user_id WHERE internal_id = $1::text AND state = 'deleted'
        )
       ON CONFLICT (user_id, assistant_id) DO UPDATE
         SET reset_at = GREATEST(chat_context_resets.reset_at, EXCLUDED.reset_at)
       RETURNING reset_at`,
      [userId, String(assistantId), at ?? null],
    );
    if (!rows.length) throw resetError('account deleted', CONTEXT_RESET_ACCOUNT_DELETED);
    return new Date(rows[0].reset_at);
  }
}
