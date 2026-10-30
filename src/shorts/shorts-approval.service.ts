import { Injectable, Logger } from '@nestjs/common';
import { InputFile } from 'grammy';
import { approverChatId } from '../blog/blog-approval.service';
import { formatSlotWhen } from '../blog/blog-slot-format';
import { NoFreeSlotError } from '../blog/blog-slots';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { buildReviewKeyboard, parseShortCallback, parseYoutubeUrl, shortCommandText } from './short-callback';
import { STAND_MARK, buildReviewCaption, clip, skitCastLine } from './short-captions';
import { autoTopicsEnabled, isStand, shortsEnabled } from './short-env';
import { LEAVE_FROM, leaveReview, noteForReview } from './short-review';
import { approveShortIntoSlot } from './short-slot-claim';
import { ShortsSettingsService } from './shorts-settings.service';
import { MIN_ORDER_CHARS, ShortsTopicService } from './shorts-topic.service';
import {
  MAX_NOTE_PROMPTS, ShortStatus, ShortVideo, canTransition, rowToShort, shortsBucket,
} from './shorts.types';

/** Подсказки в поле ответа. Telegram принимает 1–64 символа. */
const NOTE_PLACEHOLDER = 'Что поправить?';
const LINK_PLACEHOLDER = 'https://youtube.com/shorts/…';

/**
 * Аренда отправки владельцу. Дольше, чем grammy ждёт ответа на загрузку
 * (timeoutSeconds по умолчанию 500 с ≈ 8,3 мин), с запасом на скачивание из
 * MinIO: пока первый процесс ещё заливает видео, второй не заберёт ролик и не
 * пришлёт его вторым сообщением. Сорвавшаяся отправка повторится, когда аренда
 * истечёт.
 */
export const REVIEW_LEASE_MINUTES = 15;
/** После стольких неудач подряд — одно сообщение владельцу и дальше повторы раз в REVIEW_SEND_PAUSE_MINUTES. */
export const REVIEW_SEND_ALERT_AFTER = 3;
export const REVIEW_SEND_PAUSE_MINUTES = 60;
/** Bot API принимает от бота файлы до 50 МБ; больше — 413 на каждой попытке. */
export const TG_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const RESHOOT = 'Ролик сейчас переснимается — замечание напишите к новому варианту.';
const REBUILD = 'Ролик сейчас пересобирается — замечание напишите к новому варианту.';
const REANIMATE = 'Сценки ролика сейчас оживают — замечание напишите к новому варианту.';

/**
 * Что делать с упавшим роликом. Вкладки «Ролики» в кабинете пока нет (план 3) —
 * есть действия API admin/shorts, их и называем.
 */
const RETRY_HINT = 'из админки роликов: retry (можно с from=directing|writing и замечанием) или reject';

/** Почему замечание не принять — по статусу. Отказ лучше молчания: ответ наш, и владелец должен знать, куда он делся. */
const NOTE_REFUSALS: Partial<Record<ShortStatus, string>> = {
  directing: RESHOOT,
  capture_queued: RESHOOT,
  capturing: RESHOOT,
  writing: 'Ролик сейчас переписывается — замечание напишите к новому варианту.',
  animate_queued: REANIMATE,
  animating: REANIMATE,
  render_queued: REBUILD,
  rendering: REBUILD,
  approved: 'Ролик уже одобрен и ждёт слота — замечание не принял. Переснять его можно кнопкой «🔄 Переснять».',
  publishing: 'Ролик прямо сейчас уходит на площадки — замечание не принял.',
  published: 'Ролик уже опубликован — замечание не принял.',
  rejected: 'Ролик отклонён — замечание не принял.',
  failed: `Ролик упал — замечание не принял. Повторить можно ${RETRY_HINT}.`,
};

const noteRefusal = (s: ShortStatus): string => NOTE_REFUSALS[s] ?? `Замечание не принял: ролик в статусе ${s}.`;

const REWORKING = 'Ролик переделывается — пришлю новый вариант';

/** Почему кнопка под сообщением уже не действует — по статусу, без внутренних имён (всплывашка, до 200 знаков). */
const BUTTON_REFUSALS: Partial<Record<ShortStatus, string>> = {
  directing: REWORKING,
  capture_queued: REWORKING,
  capturing: REWORKING,
  writing: REWORKING,
  animate_queued: REWORKING,
  animating: REWORKING,
  render_queued: REWORKING,
  rendering: REWORKING,
  approved: 'Ролик уже одобрен',
  publishing: 'Ролик уже уходит на площадки',
  published: 'Ролик уже опубликован',
  rejected: 'Ролик отклонён',
  // Всплывашка — без имён действий API (сторожит спека): их владелец получил в сообщении о сбое.
  failed: 'Ролик упал — повторить или отклонить его можно из админки роликов',
};

const buttonRefusal = (s: ShortStatus | undefined): string => (s && BUTTON_REFUSALS[s]) || 'Ролик уже обработан';
const quoted = (v: ShortVideo): string => (v.title?.trim() ? ` «${v.title.trim()}»` : '');

/** Размер файла для владельца: «51 МБ», «50,1 МБ». Вверх: 50,04 МБ не должен назваться «50 МБ — больше 50 МБ». */
function megabytes(bytes: number): string {
  return String(Math.ceil((bytes / (1024 * 1024)) * 10) / 10).replace('.', ',');
}

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
    await this.deliver(chatId, text);
  }

  /** То же без исключений, но с итогом: false — Telegram сообщение не принял (причина — в лог). */
  private async deliver(chatId: number, text: string): Promise<boolean> {
    try {
      await this.tg.sendMessage(chatId, text);
      return true;
    } catch (e: any) {
      this.logger.warn(`не смог написать ${chatId}: ${e.message}`);
      return false;
    }
  }

  /**
   * Собранный ролик без сообщения — владельцу, по одному на вызов. Захват с
   * арендой: два процесса API не пришлют один ролик дважды, а сорвавшаяся
   * отправка повторится, когда аренда истечёт. Попытки считает захват
   * (в pending_review счётчик больше никто не ведёт; новая версия от студии,
   * замечание, «Переснять» и удачная отправка его обнуляют).
   *
   * Токен захвата — lease_until текстом: Date потерял бы микросекунды, и
   * сравнение в записи не сошлось бы никогда.
   */
  async sendPendingReviews(): Promise<void> {
    const r = await this.pg.query(
      `UPDATE short_video SET lease_until = now() + make_interval(mins => $1), attempts = attempts + 1, updated_at = now()
        WHERE id = (
          SELECT id FROM short_video
           WHERE status = 'pending_review' AND review_message_id IS NULL
             AND (lease_until IS NULL OR lease_until < now())
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING *, lease_until::text AS lease_token`,
      [REVIEW_LEASE_MINUTES],
    );
    if (!r.rows.length) return;
    const v = rowToShort(r.rows[0]);
    const leaseToken: string | null = r.rows[0].lease_token ?? null;
    try {
      await this.sendForReview(v, leaseToken);
    } catch (e: any) {
      await this.reviewSendFailed(v, leaseToken, e);
    }
  }

  /**
   * Сбой отправки. До REVIEW_SEND_ALERT_AFTER — тихий повтор по истечении
   * аренды. На попытке ровно REVIEW_SEND_ALERT_AFTER — одно сообщение
   * владельцу (иначе он не узнал бы, что ролик собран, а слот проходит), с неё
   * и дальше — пауза в час: файл больше 50 МБ или пропавший в MinIO повтором
   * каждые четверть часа не лечится, а качать и заливать видео заново дорого.
   *
   * Пауза пишется по токену захвата. Не записалась — ролик изменился (новая
   * версия, замечание) или его забрал другой процесс: о старой попытке
   * владельцу не пишем.
   */
  private async reviewSendFailed(v: ShortVideo, leaseToken: string | null, e: any): Promise<void> {
    const reason = String(e?.message ?? e).trim().replace(/[.\s]+$/, '') || 'причина не записана';
    if (v.attempts < REVIEW_SEND_ALERT_AFTER) {
      this.logger.error(`ролик ${v.id} владельцу не ушёл (попытка ${v.attempts}): ${reason} — повторю через ${REVIEW_LEASE_MINUTES} мин`);
      return;
    }
    const r = await this.pg.query(
      `UPDATE short_video SET lease_until = now() + make_interval(mins => $3), last_error = $4, updated_at = now()
        WHERE id = $1 AND status = 'pending_review' AND review_message_id IS NULL AND lease_until = $2::timestamptz`,
      [v.id, leaseToken, REVIEW_SEND_PAUSE_MINUTES, clip(`отправка владельцу: ${reason}`, 1000)],
    );
    if (r.rowCount === 0) {
      this.logger.warn(`ролик ${v.id}: отправка не удалась (${reason}), но ролик уже изменился или его забрал другой процесс — паузу не записал`);
      return;
    }
    this.logger.error(`ролик ${v.id} владельцу не ушёл (попытка ${v.attempts}): ${reason} — повторю через ${REVIEW_SEND_PAUSE_MINUTES} мин`);
    if (v.attempts === REVIEW_SEND_ALERT_AFTER) {
      await this.notify(
        approverChatId(),
        `${isStand() ? STAND_MARK : ''}Ролик${quoted(v)} готов, но прислать его на проверку не смог: ${clip(reason, 600)}. Повторяю раз в час.`,
      );
    }
  }

  /**
   * Видео байтами с обложкой и кнопками; подписи, не влезшие в 1000 знаков, —
   * вторым сообщением. Сообщение записывается в ролик по токену захвата и
   * только поверх пустого review_message_id: опоздавший процесс (видео v1)
   * иначе записал бы своё сообщение поверх сообщения соседа или поверх новой
   * версии v2 — и «Одобрить» под видео v1 отправило бы в канал v2, которую
   * владелец не видел, а сама v2 владельцу не ушла бы никогда.
   */
  async sendForReview(v: ShortVideo, leaseToken: string | null): Promise<void> {
    const chatId = approverChatId();
    if (!chatId) throw new Error('BLOG_APPROVER_TG_ID не задан — показать ролик некому');
    if (!v.videoKey || !v.coverKey || !v.captions || !v.scene) {
      throw new Error('у ролика нет файла, обложки, подписей или сцены');
    }
    const bucket = shortsBucket();
    const [video, cover] = await Promise.all([
      this.storage.download({ bucket, key: v.videoKey }),
      this.storage.download({ bucket, key: v.coverKey }),
    ]);
    if (video.length > TG_UPLOAD_MAX_BYTES) {
      throw new Error(`файл ролика ${megabytes(video.length)} МБ — больше 50 МБ, Telegram его не примет`);
    }
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
      // Сценки: кто играл и во что обошлось оживление (спека сценок, «Одобрение»).
      ...(v.script?.skits
        ? { skits: { cast: skitCastLine(v.script.skits), animation: v.animation, maxOmniSeconds: (await this.settings.get()).maxOmniSeconds } }
        : {}),
    });
    const msg: any = await this.tg.sendVideo(chatId, video, {
      caption,
      reply_markup: buildReviewKeyboard(v.id),
      // Обложка — cover (Bot API 8.3): thumbnail Telegram берёт только JPEG ≤ 200 КБ
      // и ≤ 320 px, кадр 1080×1920 он молча проигнорировал бы.
      cover: new InputFile(cover, 'cover.jpg'),
      supports_streaming: true,
      width: 1080,
      height: 1920,
      ...(v.durationMs ? { duration: Math.round(v.durationMs / 1000) } : {}),
    });
    const messageId = Number(msg.message_id);
    // Сразу после видео: упади что-то дальше, повтор прислал бы видео второй раз.
    // attempts = 0 — счётчик отправки не уходит в публикацию (одобрение его не трогает).
    const w = await this.pg.query(
      `UPDATE short_video SET review_chat_id = $2, review_message_id = $3, lease_until = NULL, attempts = 0, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending_review' AND review_message_id IS NULL AND lease_until = $4::timestamptz`,
      [v.id, chatId, messageId, leaseToken],
    );
    if (w.rowCount === 0) {
      // Видео уже у владельца, но его кнопки устарели: решение — под сообщением, что записано в ролике.
      this.logger.warn(`ролик ${v.id}: отправку перехватили / ролик изменился — сообщение ${messageId} не записал`);
      return;
    }
    if (extra) await this.sendExtraCaptions(v, chatId, extra);
  }

  /**
   * Подписи вторым сообщением — уже после записи ролика, и их сбой отправку не
   * роняет: видео у владельца, повторять его незачем. Ответ на «Подписи к
   * ролику» — самое естественное место для замечания к подписям, поэтому id —
   * в приглашения к замечанию. Длинные подписи клиент режет на куски и отдаёт
   * последний — его id и запоминаем.
   */
  private async sendExtraCaptions(v: ShortVideo, chatId: number, extra: string): Promise<void> {
    try {
      const sent: any = await this.tg.sendMessage(chatId, extra);
      await this.rememberPrompt(v.id, 'note_prompt_ids', Number(sent.message_id));
    } catch (e: any) {
      this.logger.warn(`ролик ${v.id}: подписи вторым сообщением не ушли: ${e.message}`);
    }
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
    // отправил бы в канал версию, которую владелец не видел. Сверяется и чат:
    // номера сообщений уникальны только внутри чата, а ответ на приглашение к
    // замечанию узнаётся по паре «чат проверки + id».
    const stale = Number(cb?.message?.message_id) !== v.reviewMessageId || Number(cb?.message?.chat?.id) !== v.reviewChatId;
    if (parsed.action !== 'yt' && stale) {
      await this.answer(cb, 'Это сообщение устарело — решение под последним сообщением с роликом');
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
      await this.answer(cb, buttonRefusal(v.status));
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
   * «Переснять» (новая сцена на ту же тему) и «Отклонить». Запись — общая с
   * админкой (leaveReview, short-review.ts): из pending_review и approved,
   * одобренный теряет одобрение, вышедший хоть где-то не трогается. Здесь —
   * отказ без записи для заведомо неподходящего статуса и слова владельцу.
   */
  private async leave(v: ShortVideo, cb: any, chatId: number, target: 'directing' | 'rejected'): Promise<void> {
    if (!LEAVE_FROM.includes(v.status) || !canTransition(v.status, target)) {
      await this.answer(cb, buttonRefusal(v.status));
      return;
    }
    const out = await leaveReview(this.pg, v.id, target);
    if (out.ok === false) {
      await this.answer(
        cb,
        out.reason === 'released' ? 'Ролик уже вышел на площадке — переснять или отклонить нельзя' : buttonRefusal(out.status ?? undefined),
      );
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
      await this.answer(cb, noteRefusal(v.status));
      return;
    }
    // Чат уже сверен в handleCallback: приглашение уходит в чат проверки, и ответ на него узнаётся.
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
    await this.rememberPrompt(v.id, column, Number(prompt.message_id));
  }

  /** id сообщения — в конец списка ролика, не больше MAX_NOTE_PROMPTS последних. */
  private async rememberPrompt(id: string, column: 'note_prompt_ids' | 'yt_prompt_ids', messageId: number): Promise<void> {
    await this.pg.query(
      `UPDATE short_video
          SET ${column} = (${column} || $2::bigint)[greatest(cardinality(${column}) + 2 - $3, 1):]
        WHERE id = $1`,
      [id, messageId, MAX_NOTE_PROMPTS],
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
    // Запись — общая с админкой (noteForReview, short-review.ts).
    const out = await noteForReview(this.pg, v, text);
    if (out.ok === false) {
      await this.tg.sendMessage(chatId, noteRefusal(out.status ?? v.status));
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
        : 'Автозапуск выключен — запустите ролик из админки роликов: start_now.';
      await this.notify(chatId, `Принял заказ ролика: ${Array.from(text).length} знаков, кончается на «${ending(text)}». ${next}`);
    } catch (e: any) {
      await this.notify(chatId, `Не завёл ролик: ${e.message}`);
    }
    return true;
  }

  /**
   * Упавшие ролики — владельцу, каждый один раз (захват по failure_notified).
   * Telegram сообщение не принял — флаг назад, и из цикла вон: иначе тот же
   * ролик забрался бы снова в этом же вызове. Повторит следующий тик.
   * BLOG_APPROVER_TG_ID не задан — флаг остаётся: писать некому.
   */
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
      // Упавшую публикацию с этапа не переснять (from — только до одобрения), поэтому подсказка своя.
      const next = v.failedFrom === 'publishing'
        ? 'В админке роликов: retry — повторить публикацию, reject — отклонить.'
        : `Повторить можно ${RETRY_HINT}.`;
      const text = `${isStand() ? STAND_MARK : ''}Ролик${quoted(v)} ${what}: ${clip(v.lastError || 'причина не записана', 600)}\n${next}`;
      const owner = approverChatId();
      if (!owner) {
        await this.notify(null, text);
        continue;
      }
      if (await this.deliver(owner, text)) continue;
      await this.pg.query(`UPDATE short_video SET failure_notified = false WHERE id = $1 AND status = 'failed'`, [v.id]);
      return;
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
