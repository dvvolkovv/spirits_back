import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { BlogPost, BlogRubric, BlogSource, rowToPost } from './blog.types';

/**
 * Без этого окна синтетические кейсы пойдут по кругу примерно на третий
 * месяц: тем конечное число, а генератор про прошлые посты не помнит.
 */
export const DEDUP_WINDOW_DAYS = 90;

export function normalizeTopicKey(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

export interface AddTopicInput {
  rubric: BlogRubric;
  source: BlogSource;
  topicKey: string;
  topicHint?: string;
  sourceRef?: string;
}

@Injectable()
export class BlogTopicService {
  private readonly logger = new Logger(BlogTopicService.name);

  constructor(private readonly pg: PgService) {}

  /** @returns созданный пост-идею или null, если тема отбракована дедупликацией */
  async addTopic(input: AddTopicInput): Promise<BlogPost | null> {
    const key = normalizeTopicKey(input.topicKey);

    // Отклонённые темы из проверки исключены намеренно: если владелец отправил
    // пост в мусор, тема не «занята» — её можно попробовать заново.
    const dup = await this.pg.query(
      `SELECT id FROM blog_post
        WHERE topic_key = $1
          AND status <> 'rejected'
          AND created_at > now() - ($2 || ' days')::interval
        LIMIT 1`,
      [key, DEDUP_WINDOW_DAYS],
    );
    if (dup.rows.length) {
      this.logger.log(`тема "${key}" пропущена: дубль за ${DEDUP_WINDOW_DAYS} дней`);
      return null;
    }

    const r = await this.pg.query(
      `INSERT INTO blog_post (rubric, source, source_ref, topic_key, topic_hint, status)
       VALUES ($1, $2, $3, $4, $5, 'idea') RETURNING *`,
      [input.rubric, input.source, input.sourceRef ?? null, key, input.topicHint ?? null],
    );
    return rowToPost(r.rows[0]);
  }

  /**
   * Следующая тема в работу. Новость всегда вытесняет кейс — новости
   * скоропортящиеся, кейс полежит.
   */
  async takeNextIdea(): Promise<BlogPost | null> {
    const r = await this.pg.query(
      `SELECT * FROM blog_post
        WHERE status = 'idea'
        ORDER BY (rubric = 'news') DESC, created_at ASC
        LIMIT 1`,
    );
    return r.rows[0] ? rowToPost(r.rows[0]) : null;
  }

  /**
   * Темы для кейсов: какие ассистенты реально востребованы за неделю.
   * Колонка в `custom_chat_history` называется `agent` (integer) и ведёт в
   * `agents.id` — имя ассистента берём оттуда, иначе подсказка редактору
   * выглядела бы как «ассистент 12». Считаем только реплики человека:
   * ответы ассистента удвоили бы каждый ход.
   */
  async topAssistants(limit = 5): Promise<Array<{ agentId: string; agentName: string; turns: number }>> {
    const r = await this.pg.query(
      `SELECT a.id::text AS agent_id,
              coalesce(a.display_name, a.name) AS agent_name,
              count(*)::int AS turns
         FROM custom_chat_history h
         JOIN agents a ON a.id = h.agent
        WHERE h.created_at > now() - interval '7 days'
          AND h.sender_type = 'human'
        GROUP BY a.id, agent_name
        ORDER BY turns DESC
        LIMIT $1`,
      [limit],
    );
    return r.rows.map((x: any) => ({
      agentId: x.agent_id, agentName: x.agent_name, turns: Number(x.turns),
    }));
  }

  /** Заголовки последних постов — уходят редактору, чтобы он не повторялся. */
  async recentTitles(limit = 20): Promise<string[]> {
    const r = await this.pg.query(
      `SELECT title FROM blog_post
        WHERE title IS NOT NULL AND status IN ('published','approved','pending_review')
        ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x: any) => x.title);
  }
}
