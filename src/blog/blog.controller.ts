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
import { nextSlotAfter } from './blog-slots';

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
 *     проверки перехода, так что дальше он снова доехал бы до канала.
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
        const r = await this.pg.query(
          `SELECT * FROM blog_post
            WHERE status IN ('published','rejected','failed')
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

        const { slotDays, slotHourMsk } = await this.settings.get();
        const slot = data.slotAt ? this.parseSlot(data.slotAt) : nextSlotAfter(new Date(), slotDays, slotHourMsk);

        const r = await this.pg.query(
          `UPDATE blog_post SET status = 'approved', slot_at = $2, updated_at = now()
            WHERE id = $1 AND status = $3`,
          [post.id, slot.toISOString(), post.status],
        );
        this.assertApplied(r);
        return res.status(200).json(await this.load(post.id));
      }

      case 'reject': {
        const post = await this.load(String(data.id));
        this.assertTransition(post, 'rejected');
        const r = await this.pg.query(
          `UPDATE blog_post SET status = 'rejected', updated_at = now()
            WHERE id = $1 AND status = $2`,
          [post.id, post.status],
        );
        this.assertApplied(r);
        return res.status(200).json(await this.load(post.id));
      }

      case 'redraft': {
        const post = await this.load(String(data.id));
        this.assertTransition(post, 'drafting');
        const r = await this.pg.query(
          `UPDATE blog_post SET status = 'drafting', updated_at = now()
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
    if (!sent) return;
    if (new Date(current).getTime() !== new Date(sent).getTime()) {
      throw new ConflictException('пост изменился в другом месте — обнови страницу');
    }
  }

  /** `new Date('чушь').toISOString()` бросает RangeError и превращается в 500. */
  private parseSlot(raw: any): Date {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`не разобрал дату слота: ${raw}`);
    return d;
  }
}
