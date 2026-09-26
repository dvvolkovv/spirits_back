import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { BlogSettingsService } from './blog-settings.service';
import { BlogPost, BlogStatus, MAX_NOTE_PROMPTS, appendEditorNote, canTransition, rowToPost } from './blog.types';
import { BlogCallbackAction, parseBlogCallback, buildBlogKeyboard } from './blog-callback';
import { buildCaption } from './blog-text';
import { NoFreeSlotError } from './blog-slots';
import { ApprovedSlot, approveIntoFreeSlot } from './blog-slot-claim';
import { fetchImageBytes } from './blog-image.fetch';
import { formatSlotWhen } from './blog-slot-format';
import { QueueShift, formatQueueShift, leaveQueue } from './blog-queue';

/** Подсказка в открытом поле ответа. Telegram принимает 1–64 символа. */
const NOTE_PLACEHOLDER = 'Что поправить?';

/** Чат владельца (BLOG_APPROVER_TG_ID): туда приходят черновики и служебные сообщения блога. */
export function approverChatId(): number | null {
  const raw = process.env.BLOG_APPROVER_TG_ID;
  return raw ? Number(raw) : null;
}

/**
 * Почему замечание сейчас не принять — по статусу поста.
 *
 * Отказ всё равно лучше молчания: ответ на наше сообщение блог забирает себе
 * в любом статусе (иначе текст ушёл бы ассистенту), и владелец должен понять,
 * куда делось его замечание. Где есть выход — кнопка под черновиком — он
 * назван прямо.
 */
const NOTE_REFUSALS: Partial<Record<BlogStatus, string>> = {
  drafting: 'Черновик сейчас переписывается — дождитесь нового варианта и напишите замечание к нему.',
  approved: 'Пост уже одобрен и ждёт публикации — замечание не принял. Вернуть его на переработку можно кнопкой «🔄 Переписать» под черновиком.',
  publishing: 'Пост прямо сейчас уходит в канал — замечание не принял.',
  published: 'Пост уже опубликован — замечание не принял.',
  rejected: 'Пост отправлен в мусор — замечание не принял.',
  failed: 'Черновик этого поста не собрался — замечание не принял. Перезапустить его можно кнопкой «🔄 Переписать» под черновиком.',
};

function noteRefusal(status: BlogStatus): string {
  return NOTE_REFUSALS[status] ?? `Замечание не принял: пост в статусе ${status}.`;
}

/** « «Заголовок»» для вставки после слова «пост» в любом падеже — или пусто. */
function quotedTitle(post: BlogPost): string {
  const title = (post.title || '').trim();
  return title ? ` «${title}»` : '';
}

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

    // Запись — через leaveQueue, хотя в штатном ходе пост здесь в `drafting`.
    // Нештатный: черновик пишется дольше STALE_DRAFTING_MINUTES, его подбирает
    // второй тик; первый тем временем показывает свой вариант, владелец его
    // одобряет — и поздний второй возвращает уже одобренный пост на проверку
    // со своим, никем не одобренным текстом. Возврат на проверку оставлен:
    // одобрять надо то, что уйдёт в канал. Но пост при этом ушёл из очереди
    // раньше слота — и очередь сдвигается тем же правилом, что везде.
    const out = await leaveQueue(this.pg, post.id, async (tx) => {
      await tx.query(
        `UPDATE blog_post
            SET status = 'pending_review', review_chat_id = $2, review_message_id = $3, updated_at = now()
          WHERE id = $1`,
        [post.id, chatId, Number(msg.message_id)],
      );
      return true;
    });
    await this.notifyQueueShift(out.shifted, chatId);
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

  /**
   * Очередь сдвинулась — владельцу одно сообщение со всеми переездами. В
   * личке остались устаревшие «Опубликую в среду…», и без этого о новой дате
   * он узнал бы, только открыв админку. Без переездов — без сообщения.
   *
   * @param chatId чат, где владелец только что действовал (кнопка в личке);
   *        без него — BLOG_APPROVER_TG_ID, куда приходят черновики
   */
  async notifyQueueShift(shifted: QueueShift[], chatId?: number | null): Promise<void> {
    const text = formatQueueShift(shifted, new Date());
    if (!text) return;
    const to = chatId || approverChatId();
    if (!to) {
      this.logger.warn(`очередь сдвинулась, но BLOG_APPROVER_TG_ID не задан — сообщить некому: ${text}`);
      return;
    }
    await this.notify(to, text);
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

    // «Замечание» — не переход статуса: пост остаётся ждать решения, а само
    // замечание придёт следующим сообщением. В машину состояний ему незачем.
    if (parsed.action === 'note') {
      await this.promptForNote(post, cb);
      return true;
    }

    // Целевой статус для каждой кнопки — фиксированный, а не то, что решает
    // текущий код. Легальность перехода из фактического статуса поста
    // (который мог уехать дальше, пока сообщение висело в личке — вторая
    // панель управления, админка, тоже пишет в этот же post) проверяет
    // единая машина состояний, а не повторная ручная проверка здесь.
    const TARGET_STATUS: Record<Exclude<BlogCallbackAction, 'note'>, BlogStatus> = {
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
      // Слот — ближайший СВОБОДНЫЙ, а не ближайший вообще: одобренный пост
      // больше не держит очередь, и рядом с ним бывают другие одобренные.
      // Гонку с админкой и соседним процессом держит уникальный индекс, а
      // ретрай на нём живёт в approveIntoFreeSlot.
      const chatId = Number(cb?.message?.chat?.id);
      let approved: ApprovedSlot | null;
      try {
        approved = await approveIntoFreeSlot(this.pg, post.id, post.status, await this.settings.get());
      } catch (e: any) {
        if (!(e instanceof NoFreeSlotError)) throw e;
        // Пост остаётся на проверке, и владелец должен узнать почему, а не
        // смотреть на крутящиеся часики на кнопке.
        this.logger.warn(`пост ${post.id} не одобрен: ${e.message}`);
        const refusal = `Не одобрил: ${e.message}.`;
        await this.tg.answerCallbackQuery(cb.id, { text: refusal });
        await this.notify(chatId, `Блог: пост${quotedTitle(post)} не одобрен — ${e.message}.`);
        return true;
      }
      if (!approved) {
        // Между чтением и записью пост ушёл из статуса, в котором его
        // одобряли: второе касание той же кнопки или решение из админки.
        await this.tg.answerCallbackQuery(cb.id, { text: 'Пост уже обработан' });
        return true;
      }

      // Всплывашка живёт секунды и легко пропускается, поэтому та же дата
      // следом дублируется обычным сообщением через notify() — оно остаётся
      // в истории чата. chatId берём из самого callback (как handleReplyEdit
      // берёт его из msg), а не из post.reviewChatId: это тот чат, где
      // реально нажали кнопку, без лишнего похода мыслью к БД.
      //
      // Дата — того слота, который реально записан, после всех ретраев.
      const when = formatSlotWhen(approved.slot, approved.now);
      const text = `Одобрено. Опубликую ${when}.`;
      await this.tg.answerCallbackQuery(cb.id, { text });
      await this.notify(chatId, text);
      return true;
    }

    // «В мусор» и «Переписать» уводят пост из очереди, если он одобрен, — и
    // тогда следующие встают на его слот (leaveQueue), как и из админки.
    // Переход перепроверяется под блокировкой: пока сообщение висело в личке,
    // пост мог уехать дальше, и запись без условия увела бы, например,
    // `publishing` в мусор.
    const trash = parsed.action === 'no';
    const out = await leaveQueue(this.pg, post.id, async (tx, locked) => {
      if (!canTransition(locked.status, target)) return false;
      const r = await tx.query(
        trash
          // `rejected` терминален — замечания к этому посту больше некому
          // читать. В архиве админки они висели бы незакрытыми претензиями к
          // тексту, которого уже не будет.
          ? `UPDATE blog_post SET status = 'rejected', editor_notes = '{}'::text[], updated_at = now()
              WHERE id = $1 AND status = $2`
          // «Переписать» — это и есть переработка, ради которой замечания
          // копились. Стереть их здесь значило бы попросить редактора
          // переписать пост, не сказав ему, что было не так.
          //
          // Отметку захвата, наоборот, гасим: пустая означает «готов к работе
          // прямо сейчас». Иначе пост ждал бы протухания порога — до
          // пятнадцати минут вместо ближайшего тика.
          : `UPDATE blog_post SET status = 'drafting', drafting_started_at = NULL, updated_at = now()
              WHERE id = $1 AND status = $2`,
        [locked.id, locked.status],
      );
      return r.rowCount !== 0;
    });
    if (!out.applied) {
      await this.tg.answerCallbackQuery(cb.id, { text: `Пост уже обработан: ${out.before?.status ?? 'не найден'}` });
      return true;
    }
    await this.tg.answerCallbackQuery(cb.id, { text: trash ? 'В мусор' : 'Перепишу к следующему тику' });
    await this.notifyQueueShift(out.shifted, Number(cb?.message?.chat?.id));
    return true;
  }

  /**
   * Кнопка «✍️ Замечание»: приглашение с открытым полем ответа.
   *
   * Владелец получил черновик и не понял, как оставить замечание: кнопки не
   * было, а в сообщении не сказано, что надо ответить на него. Написанное
   * отдельным сообщением, а не ответом, уходило ассистенту.
   *
   * Приглашать имеет смысл только к посту на проверке — у остальных
   * замечание всё равно не принять, и ответ «пост уже обработан» здесь тот
   * же, что у остальных кнопок.
   */
  private async promptForNote(post: BlogPost, cb: any): Promise<void> {
    if (post.status !== 'pending_review') {
      await this.tg.answerCallbackQuery(cb.id, { text: `Пост уже обработан: ${post.status}` });
      return;
    }

    // Ответ на приглашение узнаётся по паре «чат проверки + id приглашения».
    // Приглашение в другом чате (кнопки остаются и под черновиками, ушедшими
    // прежнему проверяющему) опознать было бы не по чему, и ответ на него ушёл
    // бы ассистенту — хуже, чем не приглашать вовсе.
    const chatId = Number(cb?.message?.chat?.id);
    if (chatId !== post.reviewChatId) {
      await this.tg.answerCallbackQuery(cb.id, { text: 'Этот черновик на проверке в другом чате' });
      return;
    }

    // Цитируем АКТУАЛЬНЫЙ черновик, а не обязательно тот, под которым нажали:
    // кнопки остаются и под прошлыми вариантами, а замечание ляжет на текущий.
    await this.sendNotePrompt(
      post,
      chatId,
      `Что поправить в посте${quotedTitle(post)}? Напишите ответом на это сообщение.`,
      post.reviewMessageId,
    );
    await this.tg.answerCallbackQuery(cb.id);
  }

  /**
   * Приглашение к замечанию: сообщение, у которого Telegram сам открывает
   * поле ответа (ForceReply), и чей id запоминается на посте — ответ владельца
   * ссылается на приглашение, а не на черновик.
   *
   * Ответ на сообщение — `reply_parameters`: в установленном grammy 1.43.0
   * (@grammyjs/types 3.27.3) `reply_to_message_id` помечен устаревшим, а
   * `allow_sending_without_reply` есть только внутри `reply_parameters`. Без
   * него удалённый черновик ронял бы и приглашение, хотя заголовок в тексте и
   * так говорит, к какому посту оно относится.
   *
   * id дописывается в самом UPDATE, а не чтением-изменением-записью в коде:
   * двойное касание кнопки — это два обработчика, прочитавших пост раньше,
   * чем любой из них записал id, и одно приглашение из двух пропало бы, а
   * ответ на него ушёл бы ассистенту. Сверх `MAX_NOTE_PROMPTS` срез
   * отбрасывает самые старые.
   *
   * updated_at не трогаем намеренно: по нему админка ловит правку из соседней
   * вкладки (409), а запомнить приглашение — не правка поста. Условия на
   * статус в UPDATE тоже нет: если пост за это время ушёл дальше, приглашение
   * уже отправлено, и ответ на него всё равно должен узнаться своим.
   */
  private async sendNotePrompt(post: BlogPost, chatId: number, text: string, replyTo: number | null): Promise<void> {
    const prompt = await this.tg.sendMessage(chatId, text, {
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      reply_markup: { force_reply: true, input_field_placeholder: NOTE_PLACEHOLDER },
    });
    await this.pg.query(
      `UPDATE blog_post
          SET note_prompt_ids = (note_prompt_ids || $2::bigint)[greatest(cardinality(note_prompt_ids) + 2 - $3, 1):]
        WHERE id = $1`,
      [post.id, Number(prompt.message_id), MAX_NOTE_PROMPTS],
    );
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
   * «Наше» сообщение — черновик поста или приглашение к замечанию (кнопка
   * «✍️ Замечание») в этом чате, И В ЛЮБОМ СТАТУСЕ поста. Раньше поиск
   * отбирал только `pending_review`, и ответ на черновик, который уже
   * переписывается или опубликован, уходил ассистенту: замечание к посту
   * читал психолог. Теперь статус решает, что ответить владельцу, а не кому
   * достанется его текст.
   *
   * @returns true, если сообщение — ответ на наше сообщение (замечание
   * принято или владельцу объяснено, почему нет). false означает «это не
   * наше», и вызывающий код обязан пустить текст обычным путём к ассистенту.
   */
  async handleReplyEdit(msg: any): Promise<boolean> {
    const chatId = Number(msg?.chat?.id);
    const replyTo = Number(msg?.reply_to_message?.message_id);
    if (!chatId || !replyTo) return false;

    // id сообщений в Telegram свои у каждого чата — поэтому сверяем только
    // внутри чата проверки. Статуса в условии нет намеренно, см. выше.
    const r = await this.pg.query(
      `SELECT * FROM blog_post
        WHERE review_chat_id = $1
          AND (review_message_id = $2 OR $2 = ANY(note_prompt_ids))
        LIMIT 1`,
      [chatId, replyTo],
    );
    if (!r.rows.length) return false;

    const post = rowToPost(r.rows[0]);

    // Замечание принимает только пост на проверке. Машину состояний
    // спрашиваем всё равно — запись статуса везде идёт через неё.
    if (post.status !== 'pending_review' || !canTransition(post.status, 'drafting')) {
      this.logger.log(`замечание к ${post.id} не принято: пост в статусе ${post.status}`);
      await this.tg.sendMessage(chatId, noteRefusal(post.status));
      return true;
    }

    // Голосовое, фото, стикер — ответ наш, но замечания в нём нет. Поле
    // ответа, которое открывает кнопка, — то же поле, где микрофон, так что
    // надиктовать замечание голосом естественно; раньше такой ответ уходил
    // ассистенту. Просим текстом — и просим приглашением, чтобы ответ на
    // саму просьбу тоже узнался своим.
    const text = String(msg?.text || '').trim();
    if (!text) {
      await this.sendNotePrompt(
        post,
        chatId,
        `Замечание к посту${quotedTitle(post)} принимаю только текстом — напишите его ответом на это сообщение.`,
        Number(msg?.message_id) || null,
      );
      return true;
    }

    // `drafting_started_at = NULL` — пост свободен под захват прямо сейчас,
    // ждать протухания порога замечанию незачем.
    //
    // Условие на статус — в самой записи. Между чтением выше и этой записью
    // пост могли одобрить из админки; запись без условия увела бы одобренный
    // пост на переработку мимо очереди (слот освободился бы без сдвига), хотя
    // владелец уже решил. Замечание принимает только пост на проверке — и
    // проверяется это атомарно, здесь.
    const w = await this.pg.query(
      `UPDATE blog_post
          SET editor_notes = $2::text[], status = 'drafting',
              drafting_started_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending_review'`,
      [post.id, appendEditorNote(post.editorNotes, text)],
    );
    if (w.rowCount === 0) {
      const now = await this.pg.query(`SELECT status FROM blog_post WHERE id = $1`, [post.id]);
      const status: BlogStatus = now.rows[0]?.status ?? post.status;
      this.logger.log(`замечание к ${post.id} не принято: пост ушёл в ${status} раньше записи`);
      await this.tg.sendMessage(chatId, noteRefusal(status));
      return true;
    }
    await this.tg.sendMessage(chatId, 'Принял замечание — перепишу пост и пришлю заново.');
    return true;
  }
}
