import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { BlogSettingsService } from './blog-settings.service';
import { BlogPost, BlogStatus, appendEditorNote, canTransition, rowToPost } from './blog.types';
import { parseBlogCallback, buildBlogKeyboard } from './blog-callback';
import { buildCaption } from './blog-text';
import { nextSlotAfter } from './blog-slots';
import { fetchImageBytes } from './blog-image.fetch';
import { formatSlotWhen } from './blog-slot-format';

@Injectable()
export class BlogApprovalService {
  private readonly logger = new Logger(BlogApprovalService.name);

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly settings: BlogSettingsService,
  ) {}

  /**
   * Показать черновик владельцу и запомнить координаты сообщения.
   *
   * Картинку шлём байтами: по ссылке Telegram её не забирает (см.
   * `blog-image.fetch.ts`).
   */
  async sendForReview(post: BlogPost, chatId: number): Promise<void> {
    const caption = buildCaption(post.title || '', post.body || '');
    const keyboard = buildBlogKeyboard(post.id);

    let msg: any;
    try {
      const photo = await fetchImageBytes(post.imageUrl!);
      msg = await this.tg.sendPhoto(chatId, photo, { caption, reply_markup: keyboard });
    } catch (e: any) {
      // Картинка недоступна — но текст черновика уже стоил похода к редактору,
      // а файл лежит в MinIO и никуда не делся. Ронять из-за этого весь пост
      // в `failed` (так было до 21.09.2026, и владелец видел только невнятное
      // «черновик не собрался») значит выбросить готовую работу из-за
      // пятисекундной недоступности хранилища.
      //
      // Полезнее показать черновик текстом и теми же кнопками: владелец
      // прочтёт пост и решит сам — «Переписать» заодно перерисует картинку,
      // «Опубликовать» отправит в канал, где байты качаются заново и к тому
      // моменту хранилище может уже отвечать. В тексте ошибки есть ссылка на
      // файл, так что картинку можно открыть глазами прямо из сообщения.
      this.logger.warn(`черновик ${post.id}: ${e.message} — показываю текстом без картинки`);
      const note = `\n\n⚠️ Картинку приложить не удалось: ${String(e.message).slice(0, 300)}`;
      msg = await this.tg.sendMessage(chatId, `${caption}${note}`, { reply_markup: keyboard });
    }

    await this.pg.query(
      `UPDATE blog_post
          SET status = 'pending_review', review_chat_id = $2, review_message_id = $3, updated_at = now()
        WHERE id = $1`,
      [post.id, chatId, Number(msg.message_id)],
    );
  }

  /**
   * Служебное сообщение владельцу (крон сообщает о сорвавшемся черновике и
   * напоминает про слот). Отдельный метод, чтобы соседние сервисы не лезли
   * в приватный tg-клиент этого сервиса.
   *
   * Ошибку отправки глотаем осознанно: уведомление — не причина ронять тик
   * крона, который его отправлял.
   */
  async notify(chatId: number, text: string): Promise<void> {
    try {
      await this.tg.sendMessage(chatId, text);
    } catch (e: any) {
      this.logger.warn(`не смог уведомить ${chatId}: ${e.message}`);
    }
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

    // Целевой статус для каждой кнопки — фиксированный, а не то, что решает
    // текущий код. Легальность перехода из фактического статуса поста
    // (который мог уехать дальше, пока сообщение висело в личке — вторая
    // панель управления, админка, тоже пишет в этот же post) проверяет
    // единая машина состояний, а не повторная ручная проверка здесь.
    const TARGET_STATUS: Record<typeof parsed.action, BlogStatus> = {
      ok: 'approved',
      redo: 'drafting',
      no: 'rejected',
    };
    const target = TARGET_STATUS[parsed.action];
    if (!canTransition(post.status, target)) {
      await this.tg.answerCallbackQuery(cb.id, { text: `Пост уже обработан: ${post.status}` });
      return true;
    }

    if (parsed.action === 'ok') {
      const { slotDays, slotHourMsk } = await this.settings.get();
      const now = new Date();
      const slot = nextSlotAfter(now, slotDays, slotHourMsk);
      await this.pg.query(
        `UPDATE blog_post SET status = 'approved', slot_at = $2, updated_at = now() WHERE id = $1`,
        [post.id, slot.toISOString()],
      );

      // Всплывашка живёт секунды и легко пропускается, поэтому та же дата
      // следом дублируется обычным сообщением через notify() — оно остаётся
      // в истории чата. chatId берём из самого callback (как handleReplyEdit
      // берёт его из msg), а не из post.reviewChatId: это тот чат, где
      // реально нажали кнопку, без лишнего похода мыслью к БД.
      const when = formatSlotWhen(slot, now);
      const text = `Одобрено. Опубликую ${when}.`;
      await this.tg.answerCallbackQuery(cb.id, { text });
      await this.notify(Number(cb?.message?.chat?.id), text);
      return true;
    }

    if (parsed.action === 'no') {
      // `rejected` терминален — замечания к этому посту больше некому читать.
      // В архиве админки они висели бы незакрытыми претензиями к тексту,
      // которого уже не будет.
      await this.pg.query(
        `UPDATE blog_post SET status = 'rejected', editor_notes = '{}'::text[], updated_at = now() WHERE id = $1`,
        [post.id],
      );
      await this.tg.answerCallbackQuery(cb.id, { text: 'В мусор' });
      return true;
    }

    // «Переписать» — это и есть переработка, ради которой замечания копились.
    // Стереть их здесь значило бы попросить редактора переписать пост, не
    // сказав ему, что было не так.
    await this.pg.query(
      `UPDATE blog_post SET status = 'drafting', updated_at = now() WHERE id = $1`,
      [post.id],
    );
    await this.tg.answerCallbackQuery(cb.id, { text: 'Перепишу к следующему тику' });
    return true;
  }

  /**
   * Замечание к черновику реплаем.
   *
   * Присланный текст — это то, что НАДО ПОПРАВИТЬ, а не готовый пост. Раньше
   * он ложился прямо в `body`, и чтобы исправить одну фразу, владелец должен
   * был написать весь пост за редактора — смысл проверки был ровно обратный:
   * сказать, что не так, и получить переписанный вариант.
   *
   * Замечание накапливается (см. `appendEditorNote`), пост уходит в
   * `drafting`, и следующий тик `prepareDrafts` отдаёт его редактору вместе
   * со всеми замечаниями.
   *
   * @returns true, если сообщение — замечание к черновику. false означает
   * «это не наше», и вызывающий код обязан пустить текст обычным путём к
   * ассистенту.
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
    const chatId = Number(msg.chat.id);

    // Между выборкой и записью статус могли увести из админки или соседней
    // кнопкой. Решает та же машина состояний, что и везде, а не то, что
    // запрос отбирал по status = 'pending_review'.
    //
    // Возвращаем при этом true: сообщение опознано как реплай на НАШ
    // черновик, и пустить его дальше значит отправить текст замечания в чат
    // с ассистентом. Владельцу отвечаем, почему замечание не принято.
    if (!canTransition(post.status, 'drafting')) {
      this.logger.warn(`замечание к ${post.id}: переход ${post.status} → drafting запрещён`);
      await this.tg.sendMessage(chatId, `Замечание не принял: пост уже в статусе ${post.status}.`);
      return true;
    }

    await this.pg.query(
      `UPDATE blog_post SET editor_notes = $2::text[], status = 'drafting', updated_at = now()
        WHERE id = $1`,
      [post.id, appendEditorNote(post.editorNotes, text)],
    );
    await this.tg.sendMessage(chatId, 'Принял замечание — перепишу пост и пришлю заново.');
    return true;
  }
}
