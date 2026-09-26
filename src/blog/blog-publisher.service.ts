import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { BlogSettingsService } from './blog-settings.service';
import { BlogPost, canTransition, rowToPost } from './blog.types';
import { buildCaption } from './blog-text';
import { fetchImageBytes } from './blog-image.fetch';

/**
 * Сколько раз пытаемся отдать пост в Telegram. Попытку считает захват
 * (`attempts + 1`), поэтому счётчик переживает рестарт процесса.
 */
export const MAX_PUBLISH_ATTEMPTS = 3;

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
    //
    // `slot_at <= now()` — берём только пост, чей слот наступил. Раньше слота
    // пост уходит из очереди одним путём — через leaveQueue: publish_now
    // сначала ставит ему слот «сейчас» и сдвигает очередь. Захвати паблишер
    // пост с будущим слотом (например, перенесённый между выборкой
    // publishDue и этим захватом), слот освободился бы мимо сдвига, а пост
    // вышел бы раньше срока, который ему только что назначили.
    const claim = await this.pg.query(
      `UPDATE blog_post
          SET status = 'publishing', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'approved' AND slot_at <= now()
        RETURNING *`,
      [post.id],
    );
    if (!claim.rows.length) {
      this.logger.log(`пост ${post.id} не захвачен: его уже публикует другой вызов или слот ещё не наступил — пропускаю`);
      return { ok: false, error: 'уже публикуется или слот ещё не наступил' };
    }
    const claimed = rowToPost(claim.rows[0]);

    const caption = buildCaption(post.title || '', post.body || '');

    try {
      // Картинку качаем сами и отдаём байтами: по ссылке Telegram её не
      // забирает (см. `blog-image.fetch.ts`). Скачивание стоит внутри того же
      // try, что и отправка, и намеренно ПОСЛЕ захвата: недоступное хранилище
      // — такой же сорванный подход к каналу, как и отказ Telegram. Значит он
      // тратит попытку, пишет причину в `last_error` и возвращает пост в
      // очередь тем же путём. Качать до захвата означало бы бесконечные
      // молчаливые ретраи без счётчика и без следа в админке.
      const photo = await fetchImageBytes(post.imageUrl);
      const msg: any = await this.tg.sendPhoto(Number(channelChatId), photo, { caption });
      const messageId = Number(msg.message_id);
      const url = buildPostUrl({ id: Number(msg.chat?.id ?? channelChatId), username: msg.chat?.username }, messageId);

      // `editor_notes` чистятся только здесь, на успехе: пост вышел, и
      // претензии к его черновикам закрыты. В ветке ниже их трогать нельзя —
      // сорвавшаяся отправка возвращает пост в очередь, и правки владельца
      // ему ещё понадобятся.
      await this.pg.query(
        `UPDATE blog_post
            SET status = 'published', published_at = now(),
                tg_message_id = $2, tg_url = $3, last_error = NULL,
                editor_notes = '{}'::text[], updated_at = now()
          WHERE id = $1`,
        [post.id, messageId, url],
      );
      this.logger.log(`пост ${post.id} опубликован: ${url}`);
      return { ok: true, tgMessageId: messageId, tgUrl: url };
    } catch (e: any) {
      // Пока попытки не исчерпаны, возвращаем пост в `approved`: следующий
      // тик крона возьмёт его снова. В `failed` ронять нельзя — оттуда
      // возврата нет, и один таймаут Telegram означал бы отменённый пост.
      const exhausted = claimed.attempts >= MAX_PUBLISH_ATTEMPTS;
      const target = exhausted ? 'failed' : 'approved';
      if (!canTransition(claimed.status, target)) {
        this.logger.error(`пост ${post.id}: переход ${claimed.status} → ${target} запрещён, статус не трогаю`);
        return { ok: false, error: e.message };
      }
      await this.pg.query(
        exhausted
          ? `UPDATE blog_post SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`
          : `UPDATE blog_post SET status = 'approved', last_error = $2, updated_at = now() WHERE id = $1`,
        [post.id, String(e.message).slice(0, 500)],
      );
      this.logger.error(
        exhausted
          ? `публикация ${post.id} сорвалась окончательно (${claimed.attempts} попытки): ${e.message}`
          : `публикация ${post.id} сорвалась (попытка ${claimed.attempts} из ${MAX_PUBLISH_ATTEMPTS}), вернул в очередь: ${e.message}`,
      );
      return { ok: false, error: e.message };
    }
  }
}
