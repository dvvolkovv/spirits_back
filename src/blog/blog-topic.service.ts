import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { BlogPost, BlogRubric, BlogSource, rowToPost } from './blog.types';

/**
 * Без этого окна синтетические кейсы пойдут по кругу примерно на третий
 * месяц: тем конечное число, а генератор про прошлые посты не помнит.
 */
export const DEDUP_WINDOW_DAYS = 90;

/**
 * Через столько минут ЗАХВАЧЕННЫЙ черновик считается брошенным и снова
 * попадает в работу: процесс умер между захватом и записью результата, и сам
 * собой такой пост из `drafting` не выйдет.
 *
 * Порог применяется к `drafting_started_at` — прямой отметке «взяли в
 * работу». Раньше он висел на `updated_at` и обходился стороной, если у поста
 * был заполнен `title`; заголовок служил косвенной уликой «этот черновик не в
 * работе, а ждёт перезаписи». Улика врала ровно там, где это дороже всего: у
 * переработки заголовок остаётся от прошлой генерации, так что пост считался
 * свободным всё время, пока его и писали, и второй тик крона брал его заново.
 *
 * Сбрасывать отметку — дело того, кто отправляет пост на переработку
 * («Переписать» в обеих панелях, замечание реплаем): пустая отметка означает
 * «готов к работе прямо сейчас», и ждать порога такому посту не нужно.
 *
 * Сам порог нужен, чтобы не отобрать черновик у живой подготовки: редактор
 * плюс генерация картинки — это десятки секунд, а на ретраях картинки и
 * минуты.
 */
export const STALE_DRAFTING_MINUTES = 15;

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
  /**
   * Тема с таким `sourceRef` заводится ровно один раз — навсегда и без
   * оглядки на статус.
   *
   * Нужно там, где `sourceRef` сам по себе описывает неповторимое событие
   * («тема `meeting-bot`, неделя 2026-W38»). Обычной дедупликации по
   * `topic_key` для этого мало: она нарочно пропускает отклонённые темы,
   * поэтому повторный прогон крона воскресил бы ровно тот анонс, который
   * владелец только что отправил в мусор.
   *
   * Флаг, а не безусловная проверка: у кейсов `sourceRef` — это ассистент
   * (`stats:12`), и такое событие обязано повторяться из месяца в месяц.
   */
  onceBySourceRef?: boolean;
}

@Injectable()
export class BlogTopicService {
  private readonly logger = new Logger(BlogTopicService.name);

  constructor(private readonly pg: PgService) {}

  /** @returns созданный пост-идею или null, если тема отбракована дедупликацией */
  async addTopic(input: AddTopicInput): Promise<BlogPost | null> {
    const key = normalizeTopicKey(input.topicKey);

    // Проверка по source_ref идёт ПЕРЕД дедупликацией по ключу и намеренно
    // не смотрит ни на статус, ни на окно: событие с таким ключом уже
    // случилось, второго такого же не будет.
    if (input.onceBySourceRef && input.sourceRef) {
      const seen = await this.pg.query(
        `SELECT id FROM blog_post WHERE source_ref = $1 LIMIT 1`,
        [input.sourceRef],
      );
      if (seen.rows.length) {
        this.logger.log(`тема "${input.sourceRef}" пропущена: уже заводилась`);
        return null;
      }
    }

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
   *
   * Для `drafting` вопрос один: занят черновик прямо сейчас или нет. Отвечает
   * на него `drafting_started_at`:
   *
   *  - пусто — пост готов к работе. Сюда попадает и запрошенная перезапись
   *    («Переписать» в обеих панелях, замечание реплаем): они гасят отметку
   *    сами, потому что владелец смотрит на устаревший черновик прямо сейчас
   *    и ждать порога ему незачем;
   *  - отметка старше порога — черновик взяли в работу и бросили (процесс умер
   *    между захватом и записью результата).
   *
   * Свежая отметка означает живую подготовку, и такой пост не выбирается.
   * Выборка, впрочем, не атомарна: развести два тика обязан захват в
   * `prepareDrafts`, а не этот SELECT.
   *
   * Обратите внимание: `title IS NOT NULL` здесь больше нет. Заголовок был
   * косвенной уликой занятости и врал на переработке — см. комментарий к
   * `STALE_DRAFTING_MINUTES`.
   */
  async takeNextIdea(): Promise<BlogPost | null> {
    const r = await this.pg.query(
      `SELECT * FROM blog_post
        WHERE status = 'idea'
           OR (status = 'drafting'
               AND (drafting_started_at IS NULL
                    OR drafting_started_at < now() - ($1 || ' minutes')::interval))
        ORDER BY (rubric = 'news') DESC, created_at ASC
        LIMIT 1`,
      [STALE_DRAFTING_MINUTES],
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
