import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { BlogSettingsService } from './blog-settings.service';
import { BlogPost } from './blog.types';
import { buildCaption } from './blog-text';

export interface PublishResult {
  ok: boolean;
  tgMessageId?: number;
  tgUrl?: string;
  error?: string;
}

export function buildPostUrl(chat: { id: number; username?: string }, messageId: number): string {
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const cleaned = String(chat.id).replace(/^-100/, '');
  return `https://t.me/c/${cleaned}/${messageId}`;
}

@Injectable()
export class BlogPublisherService {
  private readonly logger = new Logger(BlogPublisherService.name);

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly settings: BlogSettingsService,
  ) {}

  async publish(post: BlogPost): Promise<PublishResult> {
    const { channelChatId } = await this.settings.get();
    if (!channelChatId) {
      this.logger.warn('канал не настроен — публикация пропущена');
      return { ok: false, error: 'канал не настроен' };
    }
    if (!post.imageUrl) {
      this.logger.warn(`пост ${post.id} без картинки — публикация пропущена`);
      return { ok: false, error: 'у поста нет картинки' };
    }

    // Атомарный захват: выигрывает ровно один вызов. Без этого два тика крона
    // или ретрай после таймаута дают в канал два одинаковых поста.
    const claim = await this.pg.query(
      `UPDATE blog_post
          SET status = 'publishing', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'approved'
        RETURNING *`,
      [post.id],
    );
    if (!claim.rows.length) {
      this.logger.log(`пост ${post.id} уже захвачен другим вызовом — пропускаю`);
      return { ok: false, error: 'уже публикуется' };
    }

    const caption = buildCaption(post.title || '', post.body || '');

    try {
      const msg: any = await this.tg.sendPhoto(Number(channelChatId), post.imageUrl, { caption });
      const messageId = Number(msg.message_id);
      const url = buildPostUrl({ id: Number(msg.chat?.id ?? channelChatId), username: msg.chat?.username }, messageId);

      await this.pg.query(
        `UPDATE blog_post
            SET status = 'published', published_at = now(),
                tg_message_id = $2, tg_url = $3, last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [post.id, messageId, url],
      );
      this.logger.log(`пост ${post.id} опубликован: ${url}`);
      return { ok: true, tgMessageId: messageId, tgUrl: url };
    } catch (e: any) {
      await this.pg.query(
        `UPDATE blog_post SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
        [post.id, String(e.message).slice(0, 500)],
      );
      this.logger.error(`публикация ${post.id} сорвалась: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }
}
