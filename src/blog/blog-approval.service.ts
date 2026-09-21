import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { BlogSettingsService } from './blog-settings.service';
import { BlogPost, rowToPost } from './blog.types';
import { parseBlogCallback, buildBlogKeyboard } from './blog-callback';
import { buildCaption } from './blog-text';
import { nextSlotAfter } from './blog-slots';

@Injectable()
export class BlogApprovalService {
  private readonly logger = new Logger(BlogApprovalService.name);

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly settings: BlogSettingsService,
  ) {}

  /** Показать черновик владельцу и запомнить координаты сообщения. */
  async sendForReview(post: BlogPost, chatId: number): Promise<void> {
    const caption = buildCaption(post.title || '', post.body || '');
    const msg: any = await this.tg.sendPhoto(chatId, post.imageUrl!, {
      caption,
      reply_markup: buildBlogKeyboard(post.id),
    });
    await this.pg.query(
      `UPDATE blog_post
          SET status = 'pending_review', review_chat_id = $2, review_message_id = $3, updated_at = now()
        WHERE id = $1`,
      [post.id, chatId, Number(msg.message_id)],
    );
  }

  /** @returns true, если callback наш и обработан */
  async handleCallback(cb: any): Promise<boolean> {
    const parsed = parseBlogCallback(String(cb?.data || ''));
    if (!parsed) return false;

    const r = await this.pg.query(`SELECT * FROM blog_post WHERE id = $1`, [parsed.postId]);
    if (!r.rows.length) {
      await this.tg.answerCallbackQuery(cb.id, { text: 'Пост не найден' });
      return true;
    }
    const post = rowToPost(r.rows[0]);

    // Вторая панель управления — админка. Пост мог уехать дальше, пока
    // сообщение висело в личке; тогда кнопка не делает ничего.
    if (post.status !== 'pending_review') {
      await this.tg.answerCallbackQuery(cb.id, { text: `Пост уже обработан: ${post.status}` });
      return true;
    }

    if (parsed.action === 'ok') {
      const { slotDays, slotHourMsk } = await this.settings.get();
      const slot = nextSlotAfter(new Date(), slotDays, slotHourMsk);
      await this.pg.query(
        `UPDATE blog_post SET status = 'approved', slot_at = $2, updated_at = now() WHERE id = $1`,
        [post.id, slot.toISOString()],
      );
      await this.tg.answerCallbackQuery(cb.id, { text: 'Одобрено' });
      return true;
    }

    if (parsed.action === 'no') {
      await this.pg.query(
        `UPDATE blog_post SET status = 'rejected', updated_at = now() WHERE id = $1`,
        [post.id],
      );
      await this.tg.answerCallbackQuery(cb.id, { text: 'В мусор' });
      return true;
    }

    await this.pg.query(
      `UPDATE blog_post SET status = 'drafting', updated_at = now() WHERE id = $1`,
      [post.id],
    );
    await this.tg.answerCallbackQuery(cb.id, { text: 'Перепишу к следующему тику' });
    return true;
  }

  /**
   * Правка текста реплаем.
   * @returns true, если сообщение — правка черновика. false означает «это не
   * наше», и вызывающий код обязан пустить текст обычным путём к ассистенту.
   */
  async handleReplyEdit(msg: any): Promise<boolean> {
    const replyTo = msg?.reply_to_message?.message_id;
    const text = String(msg?.text || '').trim();
    if (!replyTo || !text) return false;

    const r = await this.pg.query(
      `SELECT * FROM blog_post
        WHERE review_chat_id = $1 AND review_message_id = $2 AND status = 'pending_review'
        LIMIT 1`,
      [Number(msg.chat.id), Number(replyTo)],
    );
    if (!r.rows.length) return false;

    const post = rowToPost(r.rows[0]);
    await this.pg.query(
      `UPDATE blog_post SET body = $2, updated_at = now() WHERE id = $1`,
      [post.id, text],
    );
    await this.tg.sendMessage(Number(msg.chat.id), 'Текст заменил. Жми «Опубликовать», когда готов.');
    return true;
  }
}
