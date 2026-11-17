import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../../common/services/pg.service';
import { LEGACY_FRESH_FUTURE_SLACK_MS } from './after-reset';

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
   * Ставит точку (по умолчанию — «сейчас» по часам базы, теми же, что у
   * created_at сообщений) и возвращает действующую. Точка только движется
   * вперёд: два нажатия в разных вкладках или запоздалая метка старого клиента
   * не возвращают ассистенту забытое.
   *
   * Явное время из будущего дальше окна или Invalid Date — ошибка, а не запись:
   * из-за GREATEST точка из будущего вечна и стёрла бы ассистенту память
   * навсегда, а Invalid Date иначе всплыл бы невнятной ошибкой Postgres.
   * Не обрезаем до now — почему, см. LEGACY_FRESH_FUTURE_SLACK_MS.
   */
  async reset(userId: string, assistantId: string | number, at?: Date): Promise<Date> {
    if (at !== undefined && at !== null) {
      const t = at.getTime();
      if (!Number.isFinite(t) || t > Date.now() + LEGACY_FRESH_FUTURE_SLACK_MS) {
        throw new Error('invalid context reset time');
      }
    }
    const { rows } = await this.pg.query(
      `INSERT INTO chat_context_resets (user_id, assistant_id, reset_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()))
       ON CONFLICT (user_id, assistant_id) DO UPDATE
         SET reset_at = GREATEST(chat_context_resets.reset_at, EXCLUDED.reset_at)
       RETURNING reset_at`,
      [userId, String(assistantId), at ?? null],
    );
    return new Date(rows[0].reset_at);
  }
}
