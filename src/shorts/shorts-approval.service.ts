import { Injectable, Logger } from '@nestjs/common';
import { InputFile } from 'grammy';
import { approverChatId } from '../blog/blog-approval.service';
import { formatSlotWhen } from '../blog/blog-slot-format';
import { NoFreeSlotError } from '../blog/blog-slots';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { buildReviewKeyboard, parseShortCallback, parseYoutubeUrl, shortCommandText } from './short-callback';
import { STAND_MARK, buildReviewCaption, clip } from './short-captions';
import { autoTopicsEnabled, isStand, shortsEnabled } from './short-env';
import { approveShortIntoSlot } from './short-slot-claim';
import { ShortsSettingsService } from './shorts-settings.service';
import { MIN_ORDER_CHARS, ShortsTopicService } from './shorts-topic.service';
import {
  MAX_NOTE_PROMPTS, ShortStatus, ShortVideo, appendOwnerNote, canTransition, rowToShort, shortsBucket,
} from './shorts.types';

/** Подсказки в поле ответа. Telegram принимает 1–64 символа. */
const NOTE_PLACEHOLDER = 'Что поправить?';
const LINK_PLACEHOLDER = 'https://youtube.com/shorts/…';

/** Ролик не ушёл владельцу (Telegram, MinIO) — следующая попытка через столько минут. */
export const REVIEW_LEASE_MINUTES = 5;

const RESHOOT = 'Ролик сейчас переснимается — замечание напишите к новому варианту.';
const REBUILD = 'Ролик сейчас пересобирается — замечание напишите к новому варианту.';

/** Почему замечание не принять — по статусу. Отказ лучше молчания: ответ наш, и владелец должен знать, куда он делся. */
const NOTE_REFUSALS: Partial<Record<ShortStatus, string>> = {
  directing: RESHOOT,
  capture_queued: RESHOOT,
  capturing: RESHOOT,
  writing: 'Ролик сейчас переписывается — замечание напишите к новому варианту.',
  render_queued: REBUILD,
  rendering: REBUILD,
  approved: 'Ролик уже одобрен и ждёт слота — замечание не принял. Переснять его можно кнопкой «🔄 Переснять».',
  publishing: 'Ролик прямо сейчас уходит на площадки — замечание не принял.',
  published: 'Ролик уже опубликован — замечание не принял.',
  rejected: 'Ролик отклонён — замечание не принял.',
  failed: 'Ролик не собрался — замечание не принял. Повторить его можно из админки.',
};

const noteRefusal = (s: ShortStatus): string => NOTE_REFUSALS[s] ?? `Замечание не принял: ролик в статусе ${s}.`;
const quoted = (v: ShortVideo): string => (v.title?.trim() ? ` «${v.title.trim()}»` : '');

/** Последние слова заказа — чтобы владелец видел, дошёл ли текст до конца (как caseAccepted блога). */
function ending(text: string): string {
  const chars = Array.from(text);
  const tail = chars.slice(-60).join('').replace(/\s+/g, ' ').trim();
  return chars.length > 60 ? `…${tail}` : tail;
}

@Injectable()
export class ShortsApprovalService {
  private readonly logger = new Logger(ShortsApprovalService.name);

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly storage: StorageService,
    private readonly settings: ShortsSettingsService,
    private readonly topics: ShortsTopicService,
  ) {}

  /** Служебное сообщение владельцу. Сбой отправки глотаем: он не повод ронять тик. */
  async notify(chatId: number | null, text: string): Promise<void> {
    if (!chatId) {
      this.logger.warn(`BLOG_APPROVER_TG_ID не задан — сообщить некому: ${text}`);
      return;
    }
    try {
      await this.tg.sendMessage(chatId, text);
    } catch (e: any) {
      this.logger.warn(`не смог написать ${chatId}: ${e.message}`);
    }
  }

  /**
   * Собранный ролик без сообщения — владельцу, по одному на вызов. Захват с
   * арендой: два процесса API не пришлют один ролик дважды, а сорвавшаяся
   * отправка повторится через REVIEW_LEASE_MINUTES.
   */
  async sendPendingReviews(): Promise<void> {
    const r = await this.pg.query(
      `UPDATE short_video SET lease_until = now() + make_interval(mins => $1), updated_at = now()
        WHERE id = (
          SELECT id FROM short_video
           WHERE status = 'pending_review' AND review_message_id IS NULL
             AND (lease_until IS NULL OR lease_until < now())
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [REVIEW_LEASE_MINUTES],
    );
    if (!r.rows.length) return;
    const v = rowToShort(r.rows[0]);
    try {
      await this.sendForReview(v);
    } catch (e: any) {
      this.logger.error(`ролик ${v.id} владельцу не ушёл: ${e.message} — повторю через ${REVIEW_LEASE_MINUTES} мин`);
    }
  }

  /** Видео байтами с обложкой и кнопками; подписи, не влезшие в 1000 знаков, — вторым сообщением. */
  async sendForReview(v: ShortVideo): Promise<void> {
    const chatId = approverChatId();
    if (!chatId) {
      this.logger.warn(`ролик ${v.id} готов, но BLOG_APPROVER_TG_ID не задан — показать некому`);
      return;
    }
    if (!v.videoKey || !v.coverKey || !v.captions || !v.scene) {
      throw new Error('у ролика нет файла, обложки, подписей или сцены');
    }
    const bucket = shortsBucket();
    const [video, cover] = await Promise.all([
      this.storage.download({ bucket, key: v.videoKey }),
      this.storage.download({ bucket, key: v.coverKey }),
    ]);
    const now = new Date();
    const when = v.slotAt && v.slotAt.getTime() > now.getTime()
      ? formatSlotWhen(v.slotAt, now)
      : 'в ближайший свободный слот после одобрения';
    const { caption, extra } = buildReviewCaption({
      stand: isStand(),
      rubric: v.rubric,
      angle: v.angle,
      assistantName: v.scene.assistantName,
      question: v.scene.question,
      when,
      captions: v.captions,
    });
    const msg: any = await this.tg.sendVideo(chatId, video, {
      caption,
      reply_markup: buildReviewKeyboard(v.id),
      thumbnail: new InputFile(cover, 'cover.jpg'),
      supports_streaming: true,
      width: 1080,
      height: 1920,
      ...(v.durationMs ? { duration: Math.round(v.durationMs / 1000) } : {}),
    });
    if (extra) await this.tg.sendMessage(chatId, extra);
    await this.pg.query(
      `UPDATE short_video SET review_chat_id = $2, review_message_id = $3, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending_review'`,
      [v.id, chatId, Number(msg.message_id)],
    );
  }

  /** @returns true, если кнопка наша и обработана */
  async handleCallback(cb: any): Promise<boolean> {
    const parsed = parseShortCallback(String(cb?.data || ''));
    if (!parsed) return false;
    // Кнопки решают, что уйдёт в канал, — только владельцу. Пересланное сообщение кнопки сохраняет.
    const owner = approverChatId();
    if (!owner || Number(cb?.from?.id) !== owner) {
      await this.answer(cb, 'Эти кнопки — для владельца канала');
      return true;
    }
    const v = await this.load(parsed.shortId);
    if (!v) {
      await this.answer(cb, 'Ролик не найден');
      return true;
    }
    const chatId = Number(cb?.message?.chat?.id) || owner;
    // Кнопки проверки действуют только под тем сообщением, что сейчас на проверке.
    // После «Переснять» и замечания кнопки старого сообщения остаются, а студия,
    // собрав новую версию, обнуляет review_message_id: «Одобрить» под старым
    // отправил бы в канал версию, которую владелец не видел.
    if (parsed.action !== 'yt' && Number(cb?.message?.message_id) !== v.reviewMessageId) {
      await this.answer(cb, 'Это сообщение устарело: ролик переделан, решение — под свежим сообщением');
      return true;
    }
    switch (parsed.action) {
      case 'ok':
        await this.approve(v, cb, chatId);
        break;
      case 'note':
        await this.promptForNote(v, cb, chatId);
        break;
      case 'redo':
        await this.leave(v, cb, chatId, 'directing');
        break;
      case 'no':
        await this.leave(v, cb, chatId, 'rejected');
        break;
      case 'yt':
        await this.promptForYoutube(v, cb, chatId);
        break;
    }
    return true;
  }

  private async approve(v: ShortVideo, cb: any, chatId: number): Promise<void> {
    if (v.status !== 'pending_review') {
      await this.answer(cb, `Ролик уже обработан: ${v.status}`);
      return;
    }
    let approved: { slot: Date; now: Date } | null;
    try {
      approved = await approveShortIntoSlot(this.pg, v.id, v.slotAt, await this.settings.get());
    } catch (e: any) {
      if (!(e instanceof NoFreeSlotError)) throw e;
      this.logger.warn(`ролик ${v.id} не одобрен: ${e.message}`);
      await this.answer(cb, `Не одобрил: ${e.message}`);
      await this.notify(chatId, `Ролики: ролик${quoted(v)} не одобрен — ${e.message}.`);
      return;
    }
    if (!approved) {
      await this.answer(cb, 'Ролик уже обработан');
      return;
    }
    // Всплывашка живёт секунды — та же дата остаётся и сообщением в чате.
    const text = `Одобрено. Опубликую ${formatSlotWhen(approved.slot, approved.now)}.`;
    await this.answer(cb, text);
    await this.notify(chatId, text);
  }

  /**
   * «Переснять» (новая сцена на ту же тему) и «Отклонить». Из pending_review и
   * из approved: одобренный ролик освобождает слот и теряет одобрение
   * (`approved_at = NULL`) — новую версию человек ещё не видел. Запись — с
   * условием на статус: пока сообщение висело, ролик мог уйти в публикацию.
   */
  private async leave(v: ShortVideo, cb: any, chatId: number, target: 'directing' | 'rejected'): Promise<void> {
    const from: ShortStatus[] = ['pending_review', 'approved'];
    if (!from.includes(v.status) || !canTransition(v.status, target)) {
      await this.answer(cb, `Ролик уже обработан: ${v.status}`);
      return;
    }
    const r = await this.pg.query(
      `UPDATE short_video SET status = $2, approved_at = NULL, attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = ANY($3::text[])`,
      [v.id, target, from],
    );
    if (r.rowCount === 0) {
      await this.answer(cb, 'Ролик уже обработан');
      return;
    }
    if (target === 'directing') {
      const text = 'Пересниму: новая сцена на ту же тему. Пришлю, когда будет готово.';
      await this.answer(cb, text);
      await this.notify(chatId, `Ролик${quoted(v)}: ${text}`);
    } else {
      await this.answer(cb, 'Отклонено');
    }
  }

  private async promptForNote(v: ShortVideo, cb: any, chatId: number): Promise<void> {
    if (v.status !== 'pending_review') {
      await this.answer(cb, `Ролик уже обработан: ${v.status}`);
      return;
    }
    // Ответ узнаётся по паре «чат проверки + id приглашения»; приглашение в чужом чате узнать не по чему.
    if (chatId !== v.reviewChatId) {
      await this.answer(cb, 'Этот ролик на проверке в другом чате');
      return;
    }
    await this.sendPrompt(v, 'note_prompt_ids', chatId, `Что поправить в ролике${quoted(v)}? Напишите ответом на это сообщение.`, v.reviewMessageId, NOTE_PLACEHOLDER);
    await this.answer(cb);
  }

  private async promptForYoutube(v: ShortVideo, cb: any, chatId: number): Promise<void> {
    const r = await this.pg.query(`SELECT status FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`, [v.id]);
    const status = r.rows[0]?.status;
    if (status !== 'manual_pending' && status !== 'manual_done') {
      await this.answer(cb, 'Набор для YouTube по этому ролику ещё не отправлялся');
      return;
    }
    await this.sendPrompt(v, 'yt_prompt_ids', chatId, `Пришлите ссылку на ролик${quoted(v)} в YouTube ответом на это сообщение.`, Number(cb?.message?.message_id) || null, LINK_PLACEHOLDER);
    await this.answer(cb);
  }

  /**
   * Приглашение с открытым полем ответа (ForceReply); id — в список ролика
   * прямо в UPDATE, а не чтением-изменением-записью: двойное касание не
   * теряет одно из приглашений (как sendNotePrompt блога).
   */
  private async sendPrompt(
    v: ShortVideo,
    column: 'note_prompt_ids' | 'yt_prompt_ids',
    chatId: number,
    text: string,
    replyTo: number | null,
    placeholder: string,
  ): Promise<void> {
    const prompt: any = await this.tg.sendMessage(chatId, text, {
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      reply_markup: { force_reply: true, input_field_placeholder: placeholder },
    });
    await this.pg.query(
      `UPDATE short_video
          SET ${column} = (${column} || $2::bigint)[greatest(cardinality(${column}) + 2 - $3, 1):]
        WHERE id = $1`,
      [v.id, Number(prompt.message_id), MAX_NOTE_PROMPTS],
    );
  }

  /**
   * Ответ на сообщение ролика или на приглашение. Своим он считается в любом
   * статусе ролика: статус решает, что ответить, а не кому уйдёт текст.
   * @returns false — сообщение не наше, его надо пустить к ассистенту
   */
  async handleReplyEdit(msg: any): Promise<boolean> {
    const chatId = Number(msg?.chat?.id);
    const replyTo = Number(msg?.reply_to_message?.message_id);
    if (!chatId || !replyTo) return false;
    // Ролик на проверку уходит только апруверу. Реплай из другого чата — не наш, и
    // базу он не трогает: иначе каждый реплай пользователя ассистенту шёл бы через
    // short_video, а без таблицы (сорвался первый накат) падал бы и не доходил.
    if (chatId !== approverChatId()) return false;
    const r = await this.pg.query(
      `SELECT * FROM short_video
        WHERE review_chat_id = $1
          AND (review_message_id = $2 OR $2 = ANY(note_prompt_ids) OR $2 = ANY(yt_prompt_ids))
        LIMIT 1`,
      [chatId, replyTo],
    );
    if (!r.rows.length) return false;
    const v = rowToShort(r.rows[0]);

    if (v.ytPromptIds.includes(replyTo)) {
      await this.acceptYoutubeLink(v, msg, chatId);
      return true;
    }
    if (v.status !== 'pending_review') {
      await this.tg.sendMessage(chatId, noteRefusal(v.status));
      return true;
    }
    const text = String(msg?.text || '').trim();
    if (!text) {
      await this.sendPrompt(v, 'note_prompt_ids', chatId, `Замечание к ролику${quoted(v)} принимаю только текстом — напишите его ответом на это сообщение.`, Number(msg?.message_id) || null, NOTE_PLACEHOLDER);
      return true;
    }
    // writer_rounds = 0: новый круг владельца, счётчик автоматических переписок студии — заново.
    const w = await this.pg.query(
      `UPDATE short_video
          SET owner_note = $2, status = 'writing', writer_rounds = 0, attempts = 0,
              lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending_review'`,
      [v.id, appendOwnerNote(v.ownerNote, text)],
    );
    if (w.rowCount === 0) {
      const now = await this.load(v.id);
      await this.tg.sendMessage(chatId, noteRefusal(now?.status ?? v.status));
      return true;
    }
    await this.tg.sendMessage(chatId, 'Принял замечание — поправлю ролик и пришлю заново.');
    return true;
  }

  private async acceptYoutubeLink(v: ShortVideo, msg: any, chatId: number): Promise<void> {
    const link = parseYoutubeUrl(msg?.text);
    if (!link) {
      await this.sendPrompt(v, 'yt_prompt_ids', chatId, 'Не узнал ссылку на YouTube. Пришлите ссылку вида https://youtube.com/shorts/… ответом на это сообщение.', Number(msg?.message_id) || null, LINK_PLACEHOLDER);
      return;
    }
    const r = await this.pg.query(
      `UPDATE short_publication
          SET status = 'manual_done', url = $2, external_id = $3, published_at = coalesce(published_at, now()),
              last_error = NULL, updated_at = now()
        WHERE short_id = $1 AND platform = 'youtube' AND status IN ('manual_pending', 'manual_done')`,
      [v.id, link.url, link.videoId],
    );
    await this.tg.sendMessage(
      chatId,
      r.rowCount ? `Записал ссылку YouTube: ${link.url}` : 'Набор для YouTube по этому ролику не отправлялся — ссылку не записал.',
    );
  }

  /**
   * `/short <тема или история>` — только владелец, только в личке и только при
   * включённых роликах; иначе команда не наша, и бот ответит как на
   * неизвестную. Одно сообщение — не больше одного заказа (ключ сообщения).
   */
  async handleShortCommand(msg: any): Promise<boolean> {
    const text = shortCommandText(msg?.text);
    if (text === null || !shortsEnabled()) return false;
    if (msg?.chat?.type !== 'private') return false;
    const owner = approverChatId();
    if (!owner || Number(msg?.from?.id) !== owner) return false;

    const chatId = Number(msg?.chat?.id) || owner;
    if (Array.from(text).length < MIN_ORDER_CHARS) {
      await this.notify(chatId, 'Как заказать ролик: /short и следом тема или история — можно в несколько строк.');
      return true;
    }
    const messageId = Number(msg?.message_id);
    try {
      const v = await this.topics.addManual({
        topic: text,
        rubric: 'case',
        sourceRef: messageId > 0 ? `tg:${chatId}:${messageId}` : null,
      });
      if (!v) {
        await this.notify(chatId, 'По этому сообщению ролик уже заказан — второй раз не завожу.');
        return true;
      }
      const next = autoTopicsEnabled()
        ? 'Пришлю ролик на проверку, когда до него дойдёт очередь.'
        : 'Автозапуск выключен — запустите ролик из админки.';
      await this.notify(chatId, `Принял заказ ролика: ${Array.from(text).length} знаков, кончается на «${ending(text)}». ${next}`);
    } catch (e: any) {
      await this.notify(chatId, `Не завёл ролик: ${e.message}`);
    }
    return true;
  }

  /** Упавшие ролики — владельцу, каждый один раз (захват по failure_notified). */
  async notifyFailures(limit = 5): Promise<void> {
    for (let i = 0; i < limit; i++) {
      const r = await this.pg.query(
        `UPDATE short_video SET failure_notified = true
          WHERE id = (
            SELECT id FROM short_video
             WHERE status = 'failed' AND NOT failure_notified
             ORDER BY updated_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED)
          RETURNING *`,
      );
      if (!r.rows.length) return;
      const v = rowToShort(r.rows[0]);
      const what = v.failedFrom === 'publishing' ? 'не вышел на площадки' : 'не собрался';
      await this.notify(
        approverChatId(),
        `${isStand() ? STAND_MARK : ''}Ролик${quoted(v)} ${what}: ${clip(v.lastError || 'причина не записана', 600)}\nПовторить можно из админки: retry.`,
      );
    }
  }

  private async answer(cb: any, text?: string): Promise<void> {
    try {
      await this.tg.answerCallbackQuery(cb.id, text ? { text } : {});
    } catch (e: any) {
      this.logger.warn(`answerCallbackQuery: ${e.message}`);
    }
  }

  private async load(id: string): Promise<ShortVideo | null> {
    const r = await this.pg.query(`SELECT * FROM short_video WHERE id = $1`, [id]);
    return r.rows[0] ? rowToShort(r.rows[0]) : null;
  }
}
