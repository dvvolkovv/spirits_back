import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  NotFoundException,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PgService } from '../common/services/pg.service';
import { BlogTopicService, normalizeTopicKey } from './blog-topic.service';
import { BlogSettingsService } from './blog-settings.service';
import { BlogImageService } from './blog-image.service';
import { BlogPost, BlogStatus, canTransition, rowToPost } from './blog.types';
import { NoFreeSlotError, upcomingSlots } from './blog-slots';
import { ApprovedSlot, SlotHolder, approveIntoFreeSlot, isSlotConflict, slotHolderAt, slotHolders } from './blog-slot-claim';
import { formatSlotWhen } from './blog-slot-format';

/** `free_slots`: сколько ближайших слотов отдаём, если не просили, и больше скольких не отдаём. */
export const FREE_SLOTS_DEFAULT = 6;
export const FREE_SLOTS_MAX = 20;

const STALE_POST = 'пост изменился в другом месте — обнови страницу';

/** Та же версия поста? Сравнение по моменту, а не по написанию строки. Не прислали — проверять нечего. */
function sameVersion(current: any, sent?: any): boolean {
  if (!sent) return true;
  return new Date(current).getTime() === new Date(sent).getTime();
}

/** `count` из запроса: по умолчанию 6, не больше 20; мусор — как не передан. */
function freeSlotsCount(raw: any): number {
  const n = Math.floor(Number(raw));
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n) || n < 1) return FREE_SLOTS_DEFAULT;
  return Math.min(n, FREE_SLOTS_MAX);
}

/**
 * Действия в одном POST — тот же стиль, что у admin/backlog и admin/coupons.
 * Фронтовая вкладка говорит только с этим эндпоинтом.
 *
 * Панелей управления постом две — личка бота и эта админка, причём админка
 * ещё и открыта в двух вкладках сразу. Отсюда два инварианта, которые здесь
 * держатся явно:
 *
 *  1. правка текста с устаревшей версией получает 409, а не молча затирает
 *     чужую (`assertVersion`);
 *  2. любая запись статуса проходит через `canTransition` — ту же машину
 *     состояний, что и кнопки в личке, и крон. Без этого админка стала бы
 *     дырой в обход апрува: `redraft` вернул бы в работу опубликованный пост,
 *     а `BlogApprovalService.sendForReview` пишет `pending_review` вообще без
 *     проверки перехода, так что дальше он снова доехал бы до канала;
 *  3. один пост на слот: `approve` без времени ставит в ближайший свободный
 *     слот тем же путём, что и кнопка в личке, а явное время (`approve` со
 *     `slotAt`, `reschedule`) в занятый слот не пишется — 409 slot_taken.
 *     Гарантию даёт уникальный индекс (004_one_post_per_slot.sql), код лишь
 *     не лезет туда, куда индекс всё равно не пустит.
 *
 * Отказы новых действий (`free_slots`, `reschedule`) и слотовые отказы
 * `approve` несут машинную причину в `error` ('slot_taken',
 * 'version_conflict', 'bad_request') — по ней фронт выбирает реакцию. Прежние
 * 409 остались в конверте Nest по умолчанию (`error: 'Conflict'`).
 */
@Controller('')
export class BlogController {
  constructor(
    private readonly pg: PgService,
    private readonly topics: BlogTopicService,
    private readonly settings: BlogSettingsService,
    private readonly images: BlogImageService,
  ) {}

  @Post('admin/blog')
  @UseGuards(JwtGuard, AdminGuard)
  async action(@Body() body: any, @Res() res: Response) {
    const { action, ...data } = body || {};

    switch (action) {
      case 'list': {
        const r = await this.pg.query(
          `SELECT * FROM blog_post
            WHERE status NOT IN ('published','rejected')
            ORDER BY (status = 'pending_review') DESC, slot_at NULLS LAST, created_at ASC
            LIMIT 100`,
        );
        return res.status(200).json(r.rows.map(rowToPost));
      }

      case 'archive': {
        // `failed` здесь намеренно нет: сорвавшийся пост требует внимания, и
        // место ему в очереди, где его видно и можно перезапустить. В архиве
        // он бы ещё и задвоился — `list` отдаёт всё, кроме published и
        // rejected.
        const r = await this.pg.query(
          `SELECT * FROM blog_post
            WHERE status IN ('published','rejected')
            ORDER BY coalesce(published_at, updated_at) DESC LIMIT 100`,
        );
        return res.status(200).json(r.rows.map(rowToPost));
      }

      case 'add_topic': {
        // Пустая тема дала бы идею с пустым topic_key, а он участвует в
        // дедупликации: первая же такая запись заблокировала бы все
        // следующие «пустые» темы на 90 дней.
        const topic = String(data.topic || '').trim();
        if (!topic) throw new BadRequestException('тема не может быть пустой');

        const post = await this.topics.addTopic({
          rubric: data.rubric === 'news' ? 'news' : 'case',
          source: 'manual',
          topicKey: normalizeTopicKey(topic),
          topicHint: topic,
        });
        return res.status(200).json(post ?? { skipped: 'дубль темы за последние 90 дней' });
      }

      case 'update_text': {
        const post = await this.load(String(data.id));
        this.assertVersion(post.updatedAt, data.updatedAt);
        await this.pg.query(
          `UPDATE blog_post SET title = $2, body = $3, updated_at = now() WHERE id = $1`,
          [post.id, String(data.title || ''), String(data.body || '')],
        );
        return res.status(200).json(await this.load(post.id));
      }

      case 'regenerate_image': {
        const post = await this.load(String(data.id));
        const url = await this.images.render(post.title || '', post.imagePrompt || post.topicKey);
        await this.pg.query(
          `UPDATE blog_post SET image_url = $2, updated_at = now() WHERE id = $1`,
          [post.id, url],
        );
        return res.status(200).json(await this.load(post.id));
      }

      case 'approve': {
        const post = await this.load(String(data.id));
        this.assertTransition(post, 'approved');

        if (data.slotAt) {
          // Явный слот — выбор владельца: в занятый молча не переставляем на
          // соседний, а отказываем и называем, чем он занят.
          const slot = this.parseSlot(data.slotAt);
          const r = await this.writeIntoSlot(post.id, slot, () => this.pg.query(
            `UPDATE blog_post SET status = 'approved', slot_at = $2, updated_at = now()
              WHERE id = $1 AND status = $3`,
            [post.id, slot.toISOString(), post.status],
          ));
          this.assertApplied(r);
        } else {
          // Ближайший СВОБОДНЫЙ слот — тем же путём, что и кнопка в личке.
          let approved: ApprovedSlot | null;
          try {
            approved = await approveIntoFreeSlot(this.pg, post.id, post.status, await this.settings.get());
          } catch (e: any) {
            if (e instanceof NoFreeSlotError) throw this.conflict('slot_taken', `не одобрил: ${e.message}`);
            throw e;
          }
          if (!approved) this.assertApplied({ rowCount: 0 });
        }
        return res.status(200).json(await this.load(post.id));
      }

      case 'free_slots': {
        // Ближайшие слоты расписания, начиная со следующего, и чем каждый
        // занят. Занят — это пост в approved/publishing ровно на этом
        // slot_at; пост, поставленный не в слот расписания, здесь не виден.
        const count = freeSlotsCount(data.count);
        const { slotDays, slotHourMsk } = await this.settings.get();
        const now = new Date();
        const holders = new Map((await slotHolders(this.pg, now)).map((h) => [h.slotAt.getTime(), h]));
        return res.status(200).json(upcomingSlots(now, slotDays, slotHourMsk, count).map((slot) => {
          const h = holders.get(slot.getTime());
          return { slotAt: slot.toISOString(), takenBy: h ? { id: h.id, title: h.title } : null };
        }));
      }

      case 'reschedule': {
        // Меняет только slot_at одобренного поста. Статус не трогает и в
        // машину состояний не ходит: пост был одобрен и одобренным остаётся.
        // Время любое, не обязательно слот расписания; один пост на момент
        // держит уникальный индекс.
        const slot = this.parseFutureSlot(data.slotAt);
        if (!data.id) throw this.badRequest('не указан пост');
        const post = await this.load(String(data.id));
        if (!sameVersion(post.updatedAt, data.updatedAt)) throw this.conflict('version_conflict', STALE_POST);
        if (post.status !== 'approved') {
          throw this.badRequest(`перенести можно только одобренный пост, а этот в статусе ${post.status}`);
        }

        // Условие на статус — на случай, если между чтением и записью пост
        // забрал паблишер (approved → publishing): переносить уходящий в
        // канал пост поздно, и это «изменился в другом месте», а не успех.
        const r = await this.writeIntoSlot(post.id, slot, () => this.pg.query(
          `UPDATE blog_post SET slot_at = $2, updated_at = now()
            WHERE id = $1 AND status = 'approved'`,
          [post.id, slot.toISOString()],
        ));
        if (r.rowCount === 0) throw this.conflict('version_conflict', STALE_POST);
        return res.status(200).json(await this.load(post.id));
      }

      case 'reject': {
        const post = await this.load(String(data.id));
        this.assertTransition(post, 'rejected');
        // Тот же терминальный статус, что и кнопка «В мусор» в личке, — и те
        // же последствия для замечаний. Панелей управления постом две, и
        // вторая не должна вести себя иначе первой.
        const r = await this.pg.query(
          `UPDATE blog_post SET status = 'rejected', editor_notes = '{}'::text[], updated_at = now()
            WHERE id = $1 AND status = $2`,
          [post.id, post.status],
        );
        this.assertApplied(r);
        return res.status(200).json(await this.load(post.id));
      }

      case 'redraft': {
        const post = await this.load(String(data.id));
        this.assertTransition(post, 'drafting');
        // Та же переработка, что и кнопка «Переписать» в личке, — и так же
        // гасит отметку захвата: пустая означает «готов к работе прямо
        // сейчас». Замечания при этом сохраняются: они редактору ещё нужны.
        const r = await this.pg.query(
          `UPDATE blog_post SET status = 'drafting', drafting_started_at = NULL, updated_at = now()
            WHERE id = $1 AND status = $2`,
          [post.id, post.status],
        );
        this.assertApplied(r);
        return res.status(200).json(await this.load(post.id));
      }

      case 'get_settings':
        return res.status(200).json(await this.settings.get());

      case 'update_settings':
        return res.status(200).json(await this.settings.update({
          channelChatId: data.channelChatId,
          slotDays: data.slotDays,
          slotHourMsk: data.slotHourMsk,
          imageStyle: data.imageStyle,
        }));

      default:
        return res.status(400).json({ error: `неизвестное действие: ${action}` });
    }
  }

  private async load(id: string): Promise<BlogPost> {
    const r = await this.pg.query(`SELECT * FROM blog_post WHERE id = $1`, [id]);
    if (!r.rows.length) throw new NotFoundException(`пост ${id} не найден`);
    return rowToPost(r.rows[0]);
  }

  /**
   * Единая машина состояний вместо «админ знает, что делает». Иначе через
   * `redraft` можно было бы вернуть в работу уже опубликованный пост, а
   * через `approve` — воскресить отправленный в мусор.
   */
  private assertTransition(post: BlogPost, target: BlogStatus): void {
    if (!canTransition(post.status, target)) {
      throw new ConflictException(`нельзя ${post.status} → ${target}: пост уже в статусе ${post.status}`);
    }
  }

  /**
   * Между `load` и записью статус мог уехать из личка-бота или соседней
   * вкладки. Запись идёт с `AND status = <прочитанный>`, и ноль затронутых
   * строк означает именно это — отвечаем 409, а не мнимым успехом.
   *
   * `rowCount` сверяется строго с нулём: у SELECT-подобных ответов и у
   * тестовых заглушек его может не быть вовсе, и `undefined` здесь не повод
   * считать, что запись не прошла.
   */
  private assertApplied(r: { rowCount?: number | null }): void {
    if (r && r.rowCount === 0) {
      throw new ConflictException('пост изменился в другом месте — обнови страницу');
    }
  }

  /** Вторая вкладка админки не должна молча затирать правку первой. */
  private assertVersion(current: string, sent?: string): void {
    if (!sameVersion(current, sent)) throw new ConflictException(STALE_POST);
  }

  /** `new Date('чушь').toISOString()` бросает RangeError и превращается в 500. */
  private parseSlot(raw: any): Date {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`не разобрал дату слота: ${raw}`);
    return d;
  }

  /** Время переноса: разбирается и ещё не наступило. `new Date(null)` — это 1970 год, а не «не передано». */
  private parseFutureSlot(raw: any): Date {
    const d = raw === undefined || raw === null || raw === '' ? new Date(NaN) : new Date(raw);
    if (Number.isNaN(d.getTime())) throw this.badRequest(`не разобрал время слота: ${raw}`);
    if (d.getTime() <= Date.now()) throw this.badRequest(`время слота уже прошло: ${d.toISOString()}`);
    return d;
  }

  /**
   * Записать пост в конкретный слот, выбранный владельцем. Занятый слот — это
   * отказ 409 slot_taken, а не молчаливый перенос на соседний.
   *
   * Проверка перед записью нужна, чтобы назвать в отказе пост, который слот
   * держит. Гарантию же даёт индекс: между проверкой и записью слот могли
   * занять из личка-бота, соседней вкладки или другого процесса, и тогда 23505
   * превращается в тот же 409, а не в 500.
   */
  private async writeIntoSlot(
    postId: string,
    slot: Date,
    write: () => Promise<{ rowCount?: number | null }>,
  ): Promise<{ rowCount?: number | null }> {
    const holder = await slotHolderAt(this.pg, slot);
    if (holder && holder.id !== postId) throw this.slotTaken(slot, holder);
    try {
      return await write();
    } catch (e: any) {
      if (!isSlotConflict(e)) throw e;
      throw this.slotTaken(slot, await slotHolderAt(this.pg, slot));
    }
  }

  private slotTaken(slot: Date, holder: SlotHolder | null): ConflictException {
    const who = holder?.title ? `постом «${holder.title}»` : 'другим постом';
    return this.conflict('slot_taken', `слот ${formatSlotWhen(slot, new Date())} уже занят ${who}`);
  }

  /**
   * 409 с машинной причиной в `error` — контракт с фронтовой вкладкой: по
   * нему она отличает «слот занят» (выбрать другой) от «пост изменился»
   * (перезагрузить). Конверт тот же, что у отказов Nest в остальных
   * действиях (`statusCode`, `message`, `error`), только в `error` вместо
   * общего 'Conflict' стоит причина.
   */
  private conflict(error: 'slot_taken' | 'version_conflict', message: string): ConflictException {
    return new ConflictException({ statusCode: 409, error, message });
  }

  /** 400 в том же конверте, что и `conflict`: причина в `error`, текст в `message`. */
  private badRequest(message: string): BadRequestException {
    return new BadRequestException({ statusCode: 400, error: 'bad_request', message });
  }
}
