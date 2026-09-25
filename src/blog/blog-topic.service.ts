import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TEST_USERS, TEST_USER_PATTERN } from '../common/test-users';
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

/**
 * Сколько знаков должно быть в `agents.description`, чтобы считать его
 * профилем, по которому можно писать кейс.
 *
 * Профиль отвечает на два вопроса: кто это и что умеет. Так устроены
 * описания, заведённые миграциями: «Дизайнер — логотипы, фирменный стиль,
 * макеты, баннеры и презентации» (67 знаков), «Запуск бизнеса — форма и
 * налоговый режим, …» (99). Короче двадцати — это ярлык («Юрист»,
 * «Бухгалтер»): кто — понятно, а что умеет, редактор допишет сам. Что он
 * допишет, видно по проду: без профиля Кира-дизайнер стала в кейсе
 * специалистом по планированию. Лучше кейсом меньше, чем кейс о выдуманном
 * ассистенте.
 */
export const MIN_PROFILE_CHARS = 20;

/** То же правило, что в запросе `topAssistants`, — для проверки в коде. */
export function hasClearProfile(description: string | null | undefined): boolean {
  return Array.from(String(description ?? '').trim()).length >= MIN_PROFILE_CHARS;
}

/** Кандидат в кейс: живой спрос на ассистента за неделю и его профиль. */
export interface CaseAssistant {
  agentId: string;
  agentName: string;
  /** `agents.description` — «кто это и что умеет». Единственный источник профиля для кейса. */
  description: string;
  /**
   * Реплики живых людей за неделю. Нужны только для отбора: в подсказку
   * редактору число не идёт — он пересказал бы его в посте.
   */
  turns: number;
}

/**
 * Подсказка редактору для кейса: только имя и профиль.
 *
 * Ни числа обращений, ни «чаще всего», ни «на этой неделе»: прежняя
 * подсказка их содержала, и редактор вынес в публичный пост «На этой неделе
 * чаще всего писали Кире» — внутреннюю статистику, к тому же искажённую
 * тестовыми прогонами.
 */
export function caseTopicHint(a: Pick<CaseAssistant, 'agentName' | 'description'>): string {
  const profile = a.description.trim().replace(/[\s.]+$/, '');
  return `Ассистент «${a.agentName}». Профиль — кто это и что умеет: ${profile}. ` +
    `Придумай кейс с задачей из этого профиля и не приписывай ассистенту ничего сверх него.`;
}

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
   * Темы для кейсов: к каким ассистентам живые люди реально ходили за неделю.
   *
   * Колонка в `custom_chat_history` называется `agent` (integer) и ведёт в
   * `agents.id` — оттуда имя и профиль (`description`): кейс пишется по
   * профилю, и без него редактор выдумывает ассистенту чужую специальность.
   * Считаем только реплики человека: ответы ассистента удвоили бы каждый ход.
   *
   * Кандидат — только ассистент, которого читатель найдёт в продукте
   * (`is_active`), и только с внятным профилем (`MIN_PROFILE_CHARS`). Оба
   * условия стоят в запросе, а не после него: `limit` режет уже годный
   * список, и ассистент без профиля не занимает места в топе.
   *
   * ТЕСТОВЫЕ АККАУНТЫ. Колонки user_id в `custom_chat_history` нет. Сессию
   * чат пишет как `{userId}_{assistantId}` (в «чистом листе» — с хвостом
   * `_fresh_{ts}`), а userId — это телефон или UUID (вход по почте и OAuth),
   * подчёркивания нет ни в том, ни в другом. Значит, пользователь — префикс
   * session_id до первого `_`. Так же его достаёт админка в сегментах
   * возврата, и список с маской — тот же объект, что у неё
   * (common/test-users.ts). Без фильтра неделю выигрывал Роман с тысячей
   * обращений — прогонами владельца и мониторинга.
   */
  async topAssistants(limit = 5): Promise<CaseAssistant[]> {
    const r = await this.pg.query(
      `SELECT a.id::text AS agent_id,
              coalesce(nullif(btrim(a.display_name), ''), a.name) AS agent_name,
              a.description,
              count(*)::int AS turns
         FROM custom_chat_history h
         JOIN agents a ON a.id = h.agent
        WHERE h.created_at > now() - interval '7 days'
          AND h.sender_type = 'human'
          AND a.is_active
          AND char_length(btrim(coalesce(a.description, ''), E' \\t\\r\\n')) >= $2
          AND split_part(h.session_id, '_', 1) <> ALL($3::text[])
          AND split_part(h.session_id, '_', 1) !~ $4
        GROUP BY a.id, a.name, a.display_name, a.description
        ORDER BY turns DESC, a.id ASC
        LIMIT $1`,
      [limit, MIN_PROFILE_CHARS, TEST_USERS, TEST_USER_PATTERN],
    );
    return r.rows.map((x: any) => ({
      agentId: x.agent_id,
      agentName: x.agent_name,
      description: String(x.description ?? '').trim(),
      turns: Number(x.turns),
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
